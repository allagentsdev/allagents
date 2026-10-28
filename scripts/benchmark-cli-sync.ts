#!/usr/bin/env bun
/** Paired built-CLI timings on bounded, isolated local fixtures; no network latency claims. */
import { createHash } from 'node:crypto';
import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, release } from 'node:os';
import { join, resolve } from 'node:path';

const [baselineArg, candidateArg, ...flags] = process.argv.slice(2);
if (!baselineArg || !candidateArg || flags.includes('--help')) {
  console.log(
    'Usage: bun scripts/benchmark-cli-sync.ts BASELINE CANDIDATE [--samples=15] [--warmups=3] [--sizes=0,100,1000] [--trace]',
  );
  process.exit(baselineArg && candidateArg ? 0 : 2);
}
const baseline = resolve(baselineArg);
const candidate = resolve(candidateArg);
for (const path of [baseline, candidate])
  if (!existsSync(path)) throw new Error(`Missing CLI: ${path}`);
const option = (name: string, fallback: string) =>
  flags.find((flag) => flag.startsWith(`--${name}=`))?.split('=')[1] ??
  fallback;
const samples = Number(option('samples', '15'));
const warmups = Number(option('warmups', '3'));
const sizes = option('sizes', '0,100,1000').split(',').map(Number);
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  !Number.isInteger(warmups) ||
  warmups < 0 ||
  sizes.some((n) => !Number.isInteger(n) || n < 0 || n > 1000)
)
  throw new Error('Invalid bounded sample/fixture sizes');
const root = mkdtempSync('/tmp/allagents-cli-sync-bench-');
const decoder = new TextDecoder();
const rows: unknown[] = [];
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const operations = [
  'ls-remote',
  'clone',
  'pull',
  'fetch',
  'merge',
  'checkout',
  'reset',
  'rev-parse',
  'remote',
  'status',
  'config',
  'symbolic-ref',
];
function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.exitCode) throw new Error(decoder.decode(result.stderr));
  return decoder.decode(result.stdout).trim();
}
function snapshot(base: string): string {
  const entries: string[] = [];
  function visit(path: string, relative = '') {
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink())
      entries.push(`${relative}:link:${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      entries.push(`${relative}:directory`);
      for (const name of readdirSync(path).sort())
        visit(join(path, name), join(relative, name));
    } else {
      let content = readFileSync(path, 'utf8');
      if (path.endsWith('/sync-state.json')) {
        const state = JSON.parse(content);
        delete state.lastSync;
        content = JSON.stringify(state);
      }
      entries.push(`${relative}:${stat.mode & 0o777}:${content}`);
    }
  }
  for (const name of [
    '.agents',
    '.codex',
    'AGENTS.md',
    '.allagents/workspace.yaml',
    '.allagents/sync-state.json',
  ])
    visit(join(base, name), name);
  return hash(entries.join('\n'));
}

function protectedSnapshot(paths: string[]): string {
  const entries: string[] = [];
  function visit(path: string, label: string) {
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries.push(`${label}:missing`);
      return;
    }
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      entries.push(`${label}:${mode}:link:${readlinkSync(path)}`);
    } else if (stat.isDirectory()) {
      entries.push(`${label}:${mode}:directory`);
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(label, name));
    } else {
      entries.push(`${label}:${mode}:file:${readFileSync(path).toString('base64')}`);
    }
  }
  for (const [index, path] of paths.entries()) visit(path, String(index));
  return hash(entries.join('\n'));
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samplesMs: values,
  };
}
try {
  for (const size of sizes) {
    const fixture = join(root, `skills-${size}`);
    const project = join(fixture, 'project');
    const home = join(fixture, 'home');
    const source = join(fixture, 'source');
    for (const path of [
      project,
      home,
      source,
      join(home, '.allagents'),
      join(project, '.allagents'),
    ])
      mkdirSync(path, { recursive: true });
    for (let i = 0; i < size; i++) {
      const skill = join(source, 'skills', `skill-${i}`);
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, 'SKILL.md'),
        `---\nname: skill-${i}\ndescription: benchmark fixture\n---\n# Skill ${i}\n`,
      );
    }
    // Prevent the unrelated human-output update notice from starting a background request.
    writeFileSync(
      join(home, '.allagents/version-check.json'),
      JSON.stringify({
        latestVersion: '0.0.0',
        lastCheckedAt: new Date().toISOString(),
      }),
    );
    const gitConfig = join(fixture, 'gitconfig');
    writeFileSync(gitConfig, '');
    const env = {
      ...process.env,
      HOME: home,
      ALLAGENTS_TEST_HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: '1',
    };
    const protectedPaths = [
      join(source, 'skills'),
      ...[project, home].flatMap((base) => [
        join(base, '.allagents/workspace.yaml'),
        join(base, '.codex/skills/user-owned/keep.txt'),
      ]),
    ];
    let expectedProtected: string;
    let expectedResources: string;
    let cachedResources: string | undefined;
    function configure(plugin: string | null) {
      const config = `version: 2\nrepositories: []\nclients: [codex]\nplugins: ${plugin ? `\n  - source: ${JSON.stringify(plugin)}` : '[]'}\n`;
      for (const base of [project, home])
        writeFileSync(join(base, '.allagents/workspace.yaml'), config);
      for (const base of [project, home]) {
        mkdirSync(join(base, '.codex/skills/user-owned'), { recursive: true });
        writeFileSync(
          join(base, '.codex/skills/user-owned/keep.txt'),
          'preserve user content',
        );
      }
      expectedProtected = protectedSnapshot(protectedPaths);
      expectedResources = protectedSnapshot([join(source, 'skills')]);
      cachedResources = plugin === 'uat/cli-performance'
        ? join(home, '.allagents/plugins/marketplaces/uat-cli-performance/skills')
        : undefined;
    }
    function run(cli: string, args: string[], traceOutput?: string) {
      const trace = join(fixture, 'git-trace.jsonl');
      writeFileSync(trace, '');
      const command = traceOutput
        ? [
            'strace',
            '-f',
            '-c',
            '-e',
            'trace=%file',
            '-o',
            traceOutput,
            cli,
            ...args,
          ]
        : [cli, ...args];
      const start = performance.now();
      const result = Bun.spawnSync(command, {
        cwd: project,
        env: { ...env, GIT_TRACE2_EVENT: trace },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const ms = performance.now() - start;
      // Check immutable fixture expectations even during initial setup/warmups;
      // shared fixtures must not let an early mutation become the new baseline.
      if (protectedSnapshot(protectedPaths) !== expectedProtected) {
        throw new Error('Protected source/config/sentinel bytes or modes changed');
      }
      if (cachedResources && protectedSnapshot([cachedResources]) !== expectedResources) {
        throw new Error('Cached source resource bytes or modes changed');
      }
      if (result.exitCode)
        throw new Error(
          `${args.join(' ')}: ${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
        );
      const counts: Record<string, number> = { processes: 0 };
      for (const operation of operations) counts[operation] = 0;
      for (const line of readFileSync(trace, 'utf8')
        .split('\n')
        .filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.event !== 'start') continue;
        counts.processes = (counts.processes ?? 0) + 1;
        for (const operation of operations)
          if (event.argv?.includes(operation)) counts[operation] = (counts[operation] ?? 0) + 1;
      }
      return {
        ms,
        counts,
        stdout: hash(decoder.decode(result.stdout)),
        stderr: hash(decoder.decode(result.stderr)),
        state: hash(snapshot(project) + snapshot(home)),
      };
    }
    function measure(name: string, args: string[]) {
      run(baseline, args); // Materialize the selected scope before timing repeated reconciliation.
      const values = { baseline: [] as number[], candidate: [] as number[] };
      const signatures = new Set<string>();
      const counts = new Set<string>();
      for (let i = -warmups; i < samples; i++) {
        const order =
          i % 2 === 0
            ? (['baseline', 'candidate'] as const)
            : (['candidate', 'baseline'] as const);
        for (const label of order) {
          const result = run(label === 'baseline' ? baseline : candidate, args);
          if (i >= 0) {
            values[label].push(result.ms);
            signatures.add(
              JSON.stringify([result.stdout, result.stderr, result.state]),
            );
            counts.add(JSON.stringify(result.counts));
          }
        }
      }
      if (signatures.size !== 1 || counts.size !== 1)
        throw new Error(
          `${name}: baseline/candidate output, state, or Git work differs`,
        );
      const fileOperations: Record<string, string> = {};
      if (
        flags.includes('--trace') &&
        name.includes('project') &&
        size === Math.max(...sizes)
      ) {
        for (const [label, cli] of [
          ['baseline', baseline],
          ['candidate', candidate],
        ]) {
          const output = join(fixture, `strace-${label}.txt`);
          run(cli as string, args, output);
          fileOperations[label as string] = readFileSync(output, 'utf8');
        }
      }
      rows.push({
        name,
        size,
        args,
        baseline: summary(values.baseline),
        candidate: summary(values.candidate),
        gitOperations: JSON.parse([...counts][0]!),
        compatible: true,
        protectedStateSha256: expectedProtected,
        sourceResourcesSha256: expectedResources,
        fileOperations,
      });
      console.error(`Measured ${name} (${size} skills)`);
    }
    configure(size ? source : null);
    if (size === sizes[0]) {
      measure('version', ['--version']);
      measure('help', ['--help']);
    }
    for (const scope of ['project', 'user'])
      measure(`local-${scope}`, [
        '--json',
        'update',
        '--scope',
        scope,
        '--offline',
      ]);
    if (size === Math.max(...sizes) && size > 0) {
      git(source, ['init', '-b', 'main']);
      git(source, ['config', '--local', 'user.name', 'Benchmark']);
      git(source, [
        'config',
        '--local',
        'user.email',
        'benchmark@example.test',
      ]);
      git(source, ['add', '.']);
      git(source, ['commit', '-m', 'fixture']);
      const remote = join(fixture, 'remote.git');
      git(fixture, ['clone', '--bare', source, remote]);
      const originalHead = git(source, ['rev-parse', 'HEAD']);
      writeFileSync(
        gitConfig,
        `[url "file://${remote}"]\n  insteadOf = https://github.com/uat/cli-performance.git\n`,
      );
      configure('uat/cli-performance');
      for (const scope of ['project', 'user'])
        measure(`remote-${scope}`, ['--json', 'update', '--scope', scope]);
      const cache = join(
        home,
        '.allagents/plugins/marketplaces/uat-cli-performance',
      );
      if (
        git(cache, ['rev-parse', 'HEAD']) !== originalHead ||
        git(cache, ['status', '--porcelain']) !== ''
      )
        throw new Error('Cache integrity changed');
      for (const scope of ['project', 'user'])
        measure(`offline-${scope}`, [
          '--json',
          'update',
          '--scope',
          scope,
          '--offline',
        ]);
    }
  }
  console.log(
    JSON.stringify(
      {
        baseline,
        candidate,
        bundles: {
          baselineSha256: hash(readFileSync(baseline, 'utf8')),
          candidateSha256: hash(readFileSync(candidate, 'utf8')),
        },
        samples,
        warmups,
        environment: {
          bun: Bun.version,
          node: decoder
            .decode(Bun.spawnSync(['node', '--version']).stdout)
            .trim(),
          os: release(),
          cpu: cpus()[0]?.model,
        },
        profile:
          'local filesystem and local bare Git remotes; no injected delay',
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
