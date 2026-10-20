import { describe, expect, test } from 'bun:test';
import { serializeWorkspaceConfig } from '../../../src/utils/workspace-writer.js';
import { loadYaml } from '../../../src/utils/yaml.js';

describe('workspace YAML edits', () => {
  test('retains empty block sequence slots and their comments and anchors through edits', () => {
    for (const nullLine of ['  - # Empty slot\r\n', '  - &empty # Empty slot\r\n']) {
      for (const position of [0, 1, 2]) {
        const lines = ['  - one\r\n', '  - old\r\n'];
        lines.splice(position, 0, nullLine);
        const prefix = '# Header\r\nmetadata:\r\n';
        const suffix = (nullLine.includes('&empty') ? 'copy: *empty\r\n' : '') + 'clients: []\r\n';
        const original = prefix + lines.join('') + suffix;
        const config = loadYaml(original) as any;
        const oldIndex = config.metadata.indexOf('old');
        config.metadata[oldIndex] = 'new';
        expect(serializeWorkspaceConfig(config, original)).toBe(original.replace('- old', '- new'));
        const appended = loadYaml(original) as any;
        appended.metadata.push('./added');
        expect(serializeWorkspaceConfig(appended, original)).toBe(prefix + lines.join('') + '  - ./added\r\n' + suffix);
        const reordered = loadYaml(original) as any;
        reordered.metadata.reverse();
        expect(serializeWorkspaceConfig(reordered, original)).toBe(prefix + [...lines].reverse().join('') + suffix);
        const materialized = loadYaml(original) as any;
        materialized.metadata[position] = 'filled';
        const result = serializeWorkspaceConfig(materialized, original);
        expect(loadYaml(result)).toEqual(materialized);
        expect(result.match(/# Empty slot/g)).toHaveLength(1);
        expect(result).toEndWith('clients: []\r\n');
      }
    }
    const flow = 'metadata: [&empty , old, ] # Flow\r\ncopy: *empty\r\n';
    const config = loadYaml(flow) as any;
    config.metadata[1] = 'new';
    expect(serializeWorkspaceConfig(config, flow)).toBe(flow.replace('old', 'new'));
  });

  test('empties root and nested indentless lists without moving their siblings', () => {
    for (const original of [
      'plugins:\r\n- ./one # Last plugin\r\nclients: []\r\n',
      'plugins:\r\n  - source: ./one\r\n    clients:\r\n    - codex # Last client\r\n    skills: [review]\r\nmetadata: {keep: [1,2]}\r\n',
    ]) {
      const config = loadYaml(original) as any;
      if (typeof config.plugins[0] === 'string') config.plugins = [];
      else config.plugins[0].clients = [];
      const result = serializeWorkspaceConfig(config, original);
      expect(loadYaml(result)).toEqual(config);
      expect(result).toEndWith(config.plugins.length ? 'metadata: {keep: [1,2]}\r\n' : 'clients: []\r\n');
      expect(result).not.toContain('# Last');
      expect(result).not.toMatch(/(?<!\r)\n/);
      if (config.plugins.length) expect(result).toContain('    skills: [review]\r\n');
    }
  });

  test('edits a sibling beside an implicit null without changing the null source', () => {
    const original = 'metadata:\r\n  empty:\r\n  keep: old # Kept\r\nclients: []\r\n';
    const config = loadYaml(original) as any;
    config.metadata.keep = 'new';
    expect(serializeWorkspaceConfig(config, original)).toBe(original.replace('keep: old', 'keep: new'));
  });

  test('materializes implicit nulls without losing the following sibling indentation', () => {
    for (const original of [
      'metadata:\r\n  empty:\r\n  keep: old # Kept\r\nclients: []\r\n',
      'metadata:\r\n  empty: # Empty slot\r\n  keep: old # Kept\r\nclients: []\r\n',
    ]) {
      for (const value of ['new', ['new'], { value: 'new' }]) {
        const config = loadYaml(original) as any;
        config.metadata.empty = value;
        const result = serializeWorkspaceConfig(config, original);
        expect(loadYaml(result)).toEqual(config);
        expect(result).toEndWith('  keep: old # Kept\r\nclients: []\r\n');
        expect(result).not.toMatch(/(?<!\r)\n/);
        if (original.includes('# Empty slot')) expect(result.match(/# Empty slot/g)).toHaveLength(1);
      }
    }
  });

  test('appends after the last multiline flow value before its newline and comment', () => {
    for (const comment of ['', ' # Last']) {
      for (const declaration of [
        `plugins: [\r\n  "./one",\r\n  ./two${comment}\r\n]\r\n`,
        `mcpServers: {\r\n  one: {command: "node"},\r\n  two: {command: bun}${comment}\r\n}\r\n`,
      ]) {
        const original = declaration + 'metadata: {keep: [1,2]}\r\n';
        const config = loadYaml(original) as any;
        if (config.plugins) config.plugins.push('./new');
        else config.mcpServers.three = { command: 'node' };
        const result = serializeWorkspaceConfig(config, original);
        expect(loadYaml(result)).toEqual(config);
        expect(result).toContain(config.plugins ? `./two,${comment}\r\n` : `{command: bun},${comment}\r\n`);
        expect(result).toEndWith('metadata: {keep: [1,2]}\r\n');
        expect(result).not.toMatch(/(?<!\r)\n/);
      }
    }
  });

  test('moves a former last flow value into the middle with its inline comment', () => {
    for (const comment of ['', ' # Last']) {
      const original = `plugins: [\n  "./one",\n  ./two,\n  ./three${comment}\n]\nmetadata: {keep: [1,2]}\n`;
      const config = loadYaml(original) as any;
      config.plugins = [config.plugins[0], config.plugins[2], config.plugins[1]];
      const result = serializeWorkspaceConfig(config, original);
      expect(loadYaml(result)).toEqual(config);
      expect(result).toContain(`./three,${comment}\n`);
      expect(result).toContain('"./one"');
      expect(result).toEndWith('metadata: {keep: [1,2]}\n');
    }
  });

  test('changes explicit-key skill selection between allowlist and exclusion without losing boundary comments', () => {
    const prefix = 'plugins:\r\n  - source: ./one\r\n    ? skills # Selection key\r\n    :';
    const suffix = 'metadata: {keep: [1,2]}\r\n';
    for (const boundary of [' ', ' # Colon boundary\r\n      ']) {
      const original = `${prefix}${boundary}[review] # Selection value\r\n${suffix}`;
      const config = loadYaml(original) as any;
      config.plugins[0].skills = { exclude: ['review'] };
      const excluded = serializeWorkspaceConfig(config, original);
      expect(loadYaml(excluded)).toEqual(config);
      expect(excluded).toStartWith(prefix);
      expect(excluded.match(/# Selection key/g)).toHaveLength(1);
      if (boundary.includes('#')) expect(excluded).toContain(': # Colon boundary\r\n');
      expect(excluded.match(/# Selection value/g)).toHaveLength(1);
      expect(excluded).toEndWith(suffix);
      config.plugins[0].skills = ['review'];
      const allowed = serializeWorkspaceConfig(config, excluded);
      expect(loadYaml(allowed)).toEqual(config);
      expect(allowed).toStartWith(prefix);
      expect(allowed.match(/# Selection key/g)).toHaveLength(1);
      if (boundary.includes('#')) expect(allowed).toContain(': # Colon boundary\r\n');
      expect(allowed.match(/# Selection value/g)).toHaveLength(1);
      expect(allowed).toEndWith(suffix);
      expect(allowed).not.toMatch(/(?<!\r)\n/);
    }
  });

  test('adds a value to an explicit null key that has no colon', () => {
    const original = 'metadata:\r\n  ? "key" # Key boundary\r\nclients: []\r\n';
    const config = loadYaml(original) as any;
    config.metadata.key = { value: 'new' };
    const result = serializeWorkspaceConfig(config, original);
    expect(loadYaml(result)).toEqual(config);
    expect(result).toContain('? "key" # Key boundary\r\n  :');
    expect(result.match(/# Key boundary/g)).toHaveLength(1);
    expect(result).toEndWith('clients: []\r\n');
  });

  test('changes literal and folded block scalar values with CRLF and header comments', () => {
    for (const style of ['|-', '>-']) {
      const prefix = '\uFEFF# Header\r\n---\r\nmetadata:\r\n    script: ';
      const suffix = '    sibling: {keep: [1,2]}\r\n... # End\r\n# Footer';
      for (const content of ['        old line\r\n', '']) {
        const original = `${prefix}${style} # Script header\r\n${content}${suffix}`;
        for (const value of ['', 'new line', 'first\nsecond\n', 'first\n\nsecond']) {
          const config = loadYaml(original) as any;
          config.metadata.script = value;
          const result = serializeWorkspaceConfig(config, original);
          expect(loadYaml(result)).toEqual(config);
          expect(result).toStartWith(prefix);
          expect(result).toEndWith(suffix);
          expect(result.match(/# Script header/g)).toHaveLength(1);
          expect(result).not.toMatch(/(?<!\r)\n/);
        }
      }
    }
  });

  test('renames a scalar without changing any other CRLF or four-space source bytes', () => {
    const original = '# Header\r\nrepositories:\r\n    - name: "old" # Repository\r\n      path: ./repo\r\nmetadata: {a: 1,b: ["x",  y]} # User spacing\r\nclients: [codex:copy]\r\n';
    const config = loadYaml(original) as any;
    config.repositories[0].name = 'new';
    expect(serializeWorkspaceConfig(config, original)).toBe(original.replace('"old"', '"new"'));
  });

  test('adds, removes and reorders block entries with their exact source and comments', () => {
    const original = 'plugins:\r\n    - ./remove # Obsolete\r\n\r\n    # One\r\n    - "./one" # First\r\n\r\n    # Two\r\n    - {source: ./two, skills: [a,b]} # Second\r\nmetadata: {keep: [1,2]}\r\n';
    const config = loadYaml(original) as any;
    config.plugins = [config.plugins[2], config.plugins[1], './new'];
    const result = serializeWorkspaceConfig(config, original, { removedPluginIndexes: [0] });
    expect(result).toBe('plugins:\r\n\r\n    # Two\r\n    - {source: ./two, skills: [a,b]} # Second\r\n\r\n    # One\r\n    - "./one" # First\r\n    - ./new\r\nmetadata: {keep: [1,2]}\r\n');
    expect(loadYaml(result)).toEqual(config);
  });

  test('edits flow lists and maps while retaining surviving entry spelling', () => {
    const original = 'plugins: ["./one",./remove, {source: ./two, skills: [a,b]}]\nmetadata: {"keep": [1,2], remove: old}\n';
    const config = loadYaml(original) as any;
    config.plugins = [config.plugins[2], config.plugins[0], './new'];
    delete config.metadata.remove;
    config.metadata.add = 'new';
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('{source: ./two, skills: [a,b]}');
    expect(result).toContain('"./one"');
    expect(result).toContain('"keep": [1,2]');
    expect(result).not.toContain('./remove');
    expect(result).not.toContain('remove: old');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps flow inline comments with their declarations across removals and moves', () => {
    const original = 'plugins: ["./one", # First\n  ./two, # Second\n  ./three, # Third\n]\nmetadata: {keep: [1,2]}\n';
    const result = serializeWorkspaceConfig({ plugins: ['./three', './one'], metadata: { keep: [1, 2] } }, original);
    expect(result).toContain('./three, # Third');
    expect(result).toMatch(/"\.\/one"[,]? # First/);
    expect(result).not.toContain('# Second');
    expect(result).toContain('metadata: {keep: [1,2]}\n');
    expect(loadYaml(result)).toEqual({ plugins: ['./three', './one'], metadata: { keep: [1, 2] } });
  });

  test('expands a flow plugin with its source comment exactly once', () => {
    const original = 'plugins: [./plugin, # Local tools\n  ./other] # Plugins\nmetadata: {keep: [1,2]}\n';
    const config = loadYaml(original) as any;
    config.plugins[0] = { source: './plugin', skills: ['review'] };
    const result = serializeWorkspaceConfig(config, original);
    expect(result.match(/# Local tools/g)).toHaveLength(1);
    expect(result).toContain('source: ./plugin, # Local tools');
    expect(result).toContain('metadata: {keep: [1,2]}\n');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps commas inside comments when moving a flow entry with a leading note', () => {
    const original = 'plugins: [ # First, local tools\n  "./one",./two]\nmetadata: {keep: [1,2]}\n';
    const config = loadYaml(original) as any;
    config.plugins.reverse();
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('# First, local tools');
    expect(result).toContain('"./one"');
    expect(result).toContain('metadata: {keep: [1,2]}\n');
    expect(loadYaml(result)).toEqual(config);
  });

  test('removes last and only entries in block and flow containers', () => {
    for (const original of [
      'plugins:\r\n    - "./one" # First\r\n    - ./two # Last\r\nmetadata: {keep: [1,2]}\r\n',
      'plugins: ["./one",./two]\r\nmetadata: {keep: [1,2]}\r\n',
    ]) {
      const config = loadYaml(original) as any;
      config.plugins.pop();
      const result = serializeWorkspaceConfig(config, original);
      expect(result).toContain('"./one"');
      expect(result).toContain('metadata: {keep: [1,2]}\r\n');
      expect(loadYaml(result)).toEqual(config);
      config.plugins = [];
      const empty = serializeWorkspaceConfig(config, result);
      expect(empty).toContain('metadata: {keep: [1,2]}\r\n');
      expect(loadYaml(empty)).toEqual(config);
    }
  });

  test('adds and removes block map fields without rewriting surviving fields', () => {
    const original = 'mcpServers:\r\n    keep:\r\n        command: "node" # Runtime\r\n        args: ["a",b]\r\n    remove: {command: old}\r\nmetadata: { untouched: yes }\r\n';
    const config = loadYaml(original) as any;
    delete config.mcpServers.remove;
    config.mcpServers.add = { command: 'bun' };
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('    keep:\r\n        command: "node" # Runtime\r\n        args: ["a",b]\r\n');
    expect(result).toContain('metadata: { untouched: yes }\r\n');
    expect(loadYaml(result)).toEqual(config);
    delete config.mcpServers.keep;
    delete config.mcpServers.add;
    expect(loadYaml(serializeWorkspaceConfig(config, result))).toEqual(config);
  });

  test('preserves the document envelope and untouched unusual syntax during an actual edit', () => {
    const original = '\uFEFF# Header\r\n%YAML 1.2\r\n---\r\nname: old\r\nmetadata:\r\n    implicit:\r\n    explicit: null\r\n    flow: {"a": , b: [one,two,], } # Flow\r\n    script: |+ # Script\r\n        echo "keep"\r\n\r\n... # End\r\n# Footer';
    const config = loadYaml(original) as any;
    config.name = 'new';
    expect(serializeWorkspaceConfig(config, original)).toBe(original.replace('name: old', 'name: new'));
  });

  test('preserves schema-looking strings and flow-only scalar quoting on changes', () => {
    for (const original of ['value: old # Value\nmetadata: {keep: [1,2]}', 'value: [old] # Value\nmetadata: {keep: [1,2]}']) {
      for (const value of ['false', 'null', '123', 'on', 'off', 'a,b', 'a: b', '[x]', 'line\nbreak']) {
        const config = loadYaml(original) as any;
        config.value = Array.isArray(config.value) ? [value] : value;
        const result = serializeWorkspaceConfig(config, original);
        expect(loadYaml(result)).toEqual(config);
        expect(result).toContain('# Value');
        expect(result).toContain('metadata: {keep: [1,2]}');
      }
    }
  });

  test('retains no-final-newline and implicit-null siblings while editing their map', () => {
    const original = 'metadata: {empty: , "keep": old, trailing: null,} # Footer';
    const config = loadYaml(original) as any;
    config.metadata.keep = 'new';
    expect(serializeWorkspaceConfig(config, original)).toBe(original.replace('old', 'new'));
  });

  test('removes the first block entry without moving its collection header', () => {
    const original = 'plugins:\n    # Collection header\n    - ./remove # Removed\n    # Survivor\n    - "./keep" # Kept\nmetadata: {keep: [1,2]}';
    const config = loadYaml(original) as any;
    config.plugins.shift();
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('# Collection header');
    expect(result).toContain('# Survivor\n    - "./keep" # Kept\n');
    expect(result).not.toContain('# Removed');
    expect(result).toEndWith('metadata: {keep: [1,2]}');
    expect(loadYaml(result)).toEqual(config);
  });

  test('creates new workspace documents through the shared YAML schema', () => {
    const config = { plugins: ['./one'], metadata: { switch: 'on', bytes: new Uint8Array([72, 105]) } };
    expect(loadYaml(serializeWorkspaceConfig(config))).toEqual(config);
  });

  test('inserts a root value into an implicit-null document while retaining its envelope', () => {
    for (const original of ['---', '---\r\n# Header\r\n...\r\n# Footer', '&root']) {
      const config = { plugins: ['./one'] };
      const result = serializeWorkspaceConfig(config, original);
      expect(loadYaml(result)).toEqual(config);
      expect(result.endsWith('\n')).toBe(original.endsWith('\n'));
      if (original.includes('# Header')) {
        expect(result).toStartWith('---\r\n# Header\r\n');
        expect(result).toEndWith('...\r\n# Footer');
      }
    }
  });

  test('leaves a no-op document byte-for-byte intact', () => {
    const original = '# Header\nplugins: ["./one"] # inline\n\n\nclients: []\n';
    expect(serializeWorkspaceConfig(loadYaml(original), original)).toBe(original);
  });

  test('keeps exact no-op bytes and tagged alias values when reusing the parsed document', () => {
    const original = '# Header\r\nplugins: []\r\nclients: []\r\n\r\nitem: &item { a: one } # Shared\r\npairs: &pairs !!pairs [*item]\r\ncopy: *pairs # Alias\r\nordered: !!omap [*item]\r\nbinary: !!binary SGVsbG8=\r\n';
    const config = loadYaml(original) as any;
    expect(serializeWorkspaceConfig(config, original)).toBe(original);
    config.clients = ['cursor'];
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toBe(original.replace('clients: []', 'clients: [ cursor]'));
    expect(loadYaml(result)).toEqual(config);
    expect(result).toContain('# Shared');
    expect(result).toContain('copy: *pairs # Alias');
    expect(result).toContain('!!pairs');
    expect(result).toContain('!!omap');
    expect(result).toContain('!!binary');
  });

  test('keeps comments on surviving entries when removing and reordering plugins', () => {
    const original = '# Header\nplugins:\n  - ./removed # obsolete\n\n  # Infra\n  - "./infra" # Terraform\n\n  # General\n  - ./general # Review\nclients: []\n';
    const result = serializeWorkspaceConfig(
      { plugins: ['./general', './infra'], clients: [] }, original,
    );
    expect(result).toContain('# Header');
    expect(result).toContain('\n  # General\n  - ./general # Review');
    expect(result).toContain('\n\n  # Infra\n  - "./infra" # Terraform');
    expect(result).not.toContain('obsolete');
    expect(loadYaml(result)).toEqual({ plugins: ['./general', './infra'], clients: [] });
  });

  test('keeps nested comments and scalar comments when expanding a plugin', () => {
    const original = 'plugins:\n  - ./plugin # Local tools\nmcpServers:\n  test:\n    command: node # Runtime\n    args: ["server.js"] # Keep flow style\n';
    const config = loadYaml(original) as any;
    config.plugins[0] = { source: './plugin', skills: ['review'] };
    config.mcpServers.test.env = { MODE: 'dev' };
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('source: ./plugin # Local tools');
    expect(result).toContain('command: node # Runtime');
    expect(result).toContain('args: ["server.js"] # Keep flow style');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps merge keys and overrides an inherited field without editing its anchor', () => {
    const original = '# Shared defaults\ndefaults: &defaults\n  clients: [claude] # Inherited\n  plugins: []\n  repositories: []\n<<: *defaults\n';
    const config = loadYaml(original) as any;
    config.clients = ['cursor'];
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('&defaults');
    expect(result).toContain('<<: *defaults');
    expect(result).toContain('# Inherited');
    expect(loadYaml(result)).toEqual(config);
  });

  test('detaches surviving aliases when removing or changing their anchor', () => {
    for (const config of [{ copy: ['./one'] }, { defaults: ['./changed'], copy: ['./one'] }]) {
      const original = 'defaults: &defaults [./one]\ncopy: *defaults # Keep this value\n';
      const result = serializeWorkspaceConfig(config, original);
      expect(loadYaml(result)).toEqual(config);
      expect(result).toContain('# Keep this value');
    }
  });

  test('removes inherited fields without silently restoring them from a merge', () => {
    const original = 'defaults: &defaults\n  disabledSkills: [old] # Shared policy\n  clients: []\n<<: *defaults\nplugins: []\n';
    const config = loadYaml(original) as any;
    delete config.disabledSkills;
    const result = serializeWorkspaceConfig(config, original);
    expect(loadYaml(result)).toEqual(config);
    expect(result).toContain('# Shared policy');
  });

  test('removes the selected identical plugin rather than transferring its comment', () => {
    const original = 'plugins:\n  - ./same # First installation\n  - ./same # Second installation\n';
    const result = serializeWorkspaceConfig({ plugins: ['./same'] }, original, {
      removedPluginIndexes: [0],
    });
    expect(result).not.toContain('First installation');
    expect(result).toContain('# Second installation');
    expect(loadYaml(result)).toEqual({ plugins: ['./same'] });
  });

  test('keeps identical plugin comments on their original entries during indexed edits', () => {
    const original = 'plugins:\n  - ./same # First installation\n  - ./same # Second installation\n';
    const config = { plugins: [{ source: './same', mcpServers: { exclude: ['test'] } }, './same'] };
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('source: ./same # First installation');
    expect(result).toContain('- ./same # Second installation');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps nested notes when replacing a plugin source declaration', () => {
    const original = 'plugins:\n  - source: https://github.com/owner/repo # Repository note\n    clients:\n      - codex # Client note\n    skills:\n      - review # Skill note\n  - ./other # Other note\n';
    const config = loadYaml(original) as any;
    config.plugins[0].source += '.git';
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('source: https://github.com/owner/repo.git # Repository note');
    expect(result).toContain('- codex # Client note');
    expect(result).toContain('- review # Skill note');
    expect(result).toContain('- ./other # Other note');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps comment ownership when a transaction removes an entry and edits a duplicate survivor', () => {
    const original = 'plugins:\n  - ./remove\n  - ./same # First installation\n  - ./same # Second installation\n';
    const config = { plugins: [{ source: './same', skills: [] }, './same'] };
    const result = serializeWorkspaceConfig(config, original, { removedPluginIndexes: [0] });
    expect(result).toContain('source: ./same # First installation');
    expect(result).toContain('- ./same # Second installation');
    expect(loadYaml(result)).toEqual(config);
  });

  test('updates and removes numeric mapping keys using their JavaScript string identity', () => {
    const original = 'mcpServers:\n  123:\n    command: node # Numeric server\n  other:\n    command: node # Other server\n';
    const config = loadYaml(original) as any;
    config.mcpServers['123'].command = 'bun';
    const updated = serializeWorkspaceConfig(config, original);
    expect(updated).toContain('command: bun # Numeric server');
    expect(loadYaml(updated)).toEqual(config);
    delete config.mcpServers['123'];
    const removed = serializeWorkspaceConfig(config, original);
    expect(removed).toContain('# Other server');
    expect(loadYaml(removed)).toEqual(config);
  });

  test('removes an indexed plugin through an alias without restoring its old value', () => {
    const original = 'defaults: &defaults\n  - ./one # Removed\n  - ./two # Retained\nplugins: *defaults\n';
    const config = loadYaml(original) as any;
    config.plugins.splice(0, 1);
    const result = serializeWorkspaceConfig(config, original, { removedPluginIndexes: [0] });
    expect(result).toContain('# Retained');
    expect(loadYaml(result)).toEqual(config);
  });

  test('retains supported YAML tags and core string semantics in untouched fields', () => {
    const original = 'plugins: []\nclients: []\nmetadata:\n  date: !!timestamp 2024-01-01\n  data: !!binary SGVsbG8=\n  set: !!set { a: null }\n  ordered: !!omap [a: one]\n  pairs: !!pairs [a: one]\n  switch: on\n';
    const config = loadYaml(original) as any;
    config.clients = ['cursor'];
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('!!timestamp');
    expect(result).toContain('!!binary');
    expect(loadYaml(result)).toEqual(config);
  });
});
