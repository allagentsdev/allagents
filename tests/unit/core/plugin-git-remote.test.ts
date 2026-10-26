import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = 'ssh://deploy@git.example.test:2222/team/skills.git';
const pluginModule = new URL('../../../src/core/plugin.ts', import.meta.url).pathname;
const contextModule = new URL('../../../src/core/update-context.ts', import.meta.url).pathname;
let fixture: string;
let repository: string;
let fixtureEnv: NodeJS.ProcessEnv;
function git(...args: string[]) {
  return execFileSync('git', args, { env: fixtureEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function probe(body: string) {
  // A child process keeps existing suite-wide Git mocks out of transport proof.
  const result = Bun.spawnSync([process.execPath, '-e', `import {fetchPlugin, resetFetchCache, checkPluginUpdate, applyPluginUpdate} from ${JSON.stringify(pluginModule)}; import {UpdateContext} from ${JSON.stringify(contextModule)}; ${body}`], { env: fixtureEnv, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}
function operations(): string[] {
  return readFileSync(join(fixture, 'trace.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line)).filter((event) => event.event === 'cmd_name')
    .map((event) => event.name);
}
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'allagents-plugin-remote-'));
  repository = join(fixture, 'remote');
  const ssh = join(fixture, 'ssh');
  writeFileSync(ssh, '#!/bin/sh\nexec git-upload-pack "$ALLAGENTS_FIXTURE_REMOTE"\n', { mode: 0o700 });
  fixtureEnv = { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH}`, ALLAGENTS_TEST_HOME: join(fixture, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: undefined, GIT_SSH_COMMAND: ssh, ALLAGENTS_FIXTURE_REMOTE: repository, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  git('init', '--initial-branch=main', repository);
  git('-C', repository, 'config', '--local', 'user.name', 'Fixture');
  git('-C', repository, 'config', '--local', 'user.email', 'fixture@example.test');
  writeFileSync(join(repository, 'SKILL.md'), 'version one');
  git('-C', repository, 'add', 'SKILL.md');
  git('-C', repository, 'commit', '-m', 'initial');
  git('-C', repository, 'branch', 'feature/demo');
  git('-C', repository, 'tag', 'v1');
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('ordinary Git remote lifecycle', () => {
  for (const scope of ['project', 'user']) {
    for (const transport of ['ssh', 'github']) {
      it(`reports ${transport} install validation before writing ${scope} configuration`, () => {
        const config = join(fixture, 'gitconfig');
        writeFileSync(config, `[url "${source}"]\n\tinsteadOf = https://github.com/fixture/skills.git\n`);
        fixtureEnv.GIT_CONFIG_GLOBAL = config;
        const url = transport === 'ssh' ? source : 'https://github.com/fixture/skills/blob/main/SKILL.md';
        const workspaceModule = new URL('../../../src/core/workspace-modify.ts', import.meta.url).pathname;
        const userModule = new URL('../../../src/core/user-workspace.ts', import.meta.url).pathname;
        const workspace = join(fixture, 'project');
        const configPath = join(scope === 'user' ? fixtureEnv.ALLAGENTS_TEST_HOME as string : workspace, '.allagents', 'workspace.yaml');
        const result = probe(`
          import {existsSync} from 'node:fs';
          import {addPluginForTarget} from ${JSON.stringify(workspaceModule)};
          import {addUserPluginForTarget} from ${JSON.stringify(userModule)};
          const events=[];
          const target={declaration:${JSON.stringify(url)},clients:['codex'],onProgress:e=>events.push({phase:e.phase,configExists:existsSync(${JSON.stringify(configPath)})})};
          const result=await ${scope === 'user' ? 'addUserPluginForTarget(target)' : `addPluginForTarget(target,${JSON.stringify(workspace)})`};
          console.log(JSON.stringify({result,events}));
        `);
        expect(result.result.success).toBe(true);
        expect(result.events.map((event: { phase: string }) => event.phase)).toEqual(
          transport === 'ssh' ? ['downloading', 'ready'] : ['checking', 'downloading', 'ready'],
        );
        expect(result.events.every((event: { configExists: boolean }) => !event.configExists)).toBe(true);
        expect(readFileSync(configPath, 'utf8')).toContain(url);
      });
    }
  }

  it('does not treat the last of multiple configured origin URLs as the whole source identity', () => {
    const first = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    git('-C', first.cachePath, 'remote', 'set-url', 'origin', 'ssh://deploy@other.example.test/team/skills.git');
    git('-C', first.cachePath, 'remote', 'set-url', '--add', 'origin', source);
    const origins = git('-C', first.cachePath, 'config', '--get-all', 'remote.origin.url');
    fixtureEnv.GIT_TRACE2_EVENT = join(fixture, 'trace.jsonl');
    const result = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    expect(result.success).toBe(true);
    expect(operations()).toContain('pull');
    expect(git('-C', first.cachePath, 'config', '--get-all', 'remote.origin.url')).toBe(origins);
  });

  it('keeps declared source identity when user Git configuration rewrites the transport', () => {
    const config = join(fixture, 'gitconfig');
    writeFileSync(config, `[url "${source}"]\n\tinsteadOf = https://github.com/fixture/skills.git\n`);
    fixtureEnv.GIT_CONFIG_GLOBAL = config;
    const url = 'https://github.com/fixture/skills/tree/main';
    const first = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(url)})));`);
    expect(first.success).toBe(true);
    fixtureEnv.GIT_TRACE2_EVENT = join(fixture, 'trace.jsonl');
    const repeat = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(url)})));`);
    expect(repeat).toMatchObject({ success: true, resolvedSha: first.resolvedSha });
    expect(operations()).toContain('ls-remote');
    expect(operations()).not.toContain('pull');
  });

  it('checks unchanged branch and tag caches without fetching objects, then receives upstream changes', () => {
    for (const ref of ['main', 'v1']) {
      const url = JSON.stringify(`${source}#ref=${ref}`);
      const first = probe(`console.log(JSON.stringify(await fetchPlugin(${url})));`);
      const trace = join(fixture, 'trace.jsonl');
      rmSync(trace, { force: true });
      fixtureEnv.GIT_TRACE2_EVENT = trace;
      const repeat = probe(`const events=[]; const result=await fetchPlugin(${url}, {onProgress:e=>events.push(e)}); console.log(JSON.stringify({result,events}));`);
      expect(repeat.result).toMatchObject({ success: true, resolvedSha: first.resolvedSha });
      expect(operations()).toContain('ls-remote');
      expect(operations()).not.toContain('pull');
      expect(operations()).not.toContain('fetch');
      expect(repeat.events.map((event: { phase: string }) => event.phase)).toEqual(['checking', 'current']);
      delete fixtureEnv.GIT_TRACE2_EVENT;
    }
    writeFileSync(join(repository, 'SKILL.md'), 'version two');
    git('-C', repository, 'add', 'SKILL.md');
    git('-C', repository, 'commit', '-m', 'advance');
    const updated = probe(`const events=[]; const result=await fetchPlugin(${JSON.stringify(`${source}#ref=main`)}, {onProgress:e=>events.push(e)}); console.log(JSON.stringify({result,events}));`);
    expect(readFileSync(join(updated.result.cachePath, 'SKILL.md'), 'utf8')).toBe('version two');
    expect(updated.events.map((event: { phase: string }) => event.phase)).toEqual(['checking', 'updating', 'ready']);
  });

  it('preserves dirty cached files and falls back to the cache when the remote fails', () => {
    const first = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    writeFileSync(join(first.cachePath, 'SKILL.md'), 'user edit');
    writeFileSync(join(first.cachePath, 'untracked'), 'user file');
    const refresh = () => probe(`const events=[]; const result=await fetchPlugin(${JSON.stringify(source)}, {onProgress:e=>events.push(e)}); console.log(JSON.stringify({result,events}));`);
    expect(refresh().result.success).toBe(true);
    expect(readFileSync(join(first.cachePath, 'SKILL.md'), 'utf8')).toBe('user edit');
    expect(readFileSync(join(first.cachePath, 'untracked'), 'utf8')).toBe('user file');
    rmSync(repository, { recursive: true, force: true });
    const failed = refresh();
    expect(failed.result).toMatchObject({ success: true, action: 'skipped', resolvedSha: first.resolvedSha });
    expect(failed.events.map((event: { phase: string }) => event.phase)).toEqual(['checking', 'updating', 'cached']);
    expect(readFileSync(join(first.cachePath, 'SKILL.md'), 'utf8')).toBe('user edit');
  });

  it('clones and refreshes explicit GitHub SSH sources through inherited SSH configuration', () => {
    for (const githubSource of ['git@github.com:fixture/skills.git', 'ssh://git@github.com/fixture/skills.git#ref=main']) {
      const first = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(githubSource)})));`);
      expect(first.success).toBe(true);
      expect(git('-C', first.cachePath, 'remote', 'get-url', 'origin')).toBe(githubSource.split('#')[0]);
      writeFileSync(join(repository, 'SKILL.md'), githubSource);
      git('-C', repository, 'add', 'SKILL.md');
      git('-C', repository, 'commit', '-m', 'advance SSH fixture');
      const refreshed = probe(`const deps={parsePluginSpec:()=>null,getMarketplaceRegistration:async()=>null,validateMarketplaceAccess:()=>undefined,parseMarketplaceManifest:async()=>({success:false}),updateMarketplace:async()=>[]}; console.log(JSON.stringify(await applyPluginUpdate(${JSON.stringify(githubSource)},deps,new UpdateContext())));`);
      expect(refreshed).toMatchObject({ success: true, changed: true });
      expect(git('-C', first.cachePath, 'rev-parse', 'HEAD')).toBe(git('-C', repository, 'rev-parse', 'HEAD'));
    }
  });

  it('clones exact custom-port transport using inherited Git configuration at branch and tag', () => {
    const results = probe(`console.log(JSON.stringify(await Promise.all([fetchPlugin(${JSON.stringify(`${source}#ref=feature%2Fdemo`)}), fetchPlugin(${JSON.stringify(`${source}#ref=v1`)})])));`);
    for (const result of results) {
      expect(result).toMatchObject({ success: true });
      expect(result.action).toBe('fetched');
      expect(result.resolvedSha).toBe(git('-C', repository, 'rev-parse', 'HEAD'));
      expect(git('-C', result.cachePath, 'remote', 'get-url', 'origin')).toBe(source);
    }
    expect(results[0].cachePath).not.toBe(results[1].cachePath);
    expect(git('-C', results[1].cachePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
  });

  it('uses existing offline content and refuses a missing offline clone', () => {
    const missing = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)}, {offline:true})));`);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('Offline');
    const fetched = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    expect(fetched).toMatchObject({ success: true });
    fixtureEnv.GIT_TRACE2_EVENT = join(fixture, 'trace.jsonl');
    const cached = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)}, {offline:true})));`);
    expect(cached.success).toBe(true);
    expect(cached.action).toBe('skipped');
    expect(cached.resolvedSha).toBe(fetched.resolvedSha);
    expect(operations()).not.toContain('ls-remote');
    expect(operations()).not.toContain('pull');
    expect(operations()).not.toContain('fetch');
    expect(operations()).not.toContain('clone');
  });

  it('checks remote advancement, applies a refresh and reports a repeat unchanged', () => {
    const first = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    expect(first).toMatchObject({ success: true });
    writeFileSync(join(repository, 'SKILL.md'), 'version two');
    git('-C', repository, 'add', 'SKILL.md');
    git('-C', repository, 'commit', '-m', 'second');
    const updated = probe(`const deps={parsePluginSpec:()=>null,getMarketplaceRegistration:async()=>null,validateMarketplaceAccess:()=>undefined,parseMarketplaceManifest:async()=>({success:false}),updateMarketplace:async()=>[]}; const context=new UpdateContext(); const before=await checkPluginUpdate(${JSON.stringify(source)},deps,context); const result=await applyPluginUpdate(${JSON.stringify(source)},deps,context); const after=await checkPluginUpdate(${JSON.stringify(source)},deps,new UpdateContext()); const repeat=await applyPluginUpdate(${JSON.stringify(source)},deps,new UpdateContext()); console.log(JSON.stringify({before,result,after,repeat}));`);
    expect(updated.before.status).toBe('available');
    expect(updated.result).toMatchObject({ success: true, changed: true, action: 'updated' });
    expect(git('-C', first.cachePath, 'rev-parse', 'HEAD')).toBe(git('-C', repository, 'rev-parse', 'HEAD'));
    expect(updated.after.status).toBe('up-to-date');
    expect(updated.repeat).toMatchObject({ success: true, changed: false });
  });

  it('reports authentication failure against the Git remote', () => {
    writeFileSync(join(fixture, 'ssh'), '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 1\n', { mode: 0o700 });
    const result = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
    expect(result.error).toContain(source);
  });

  it('retains usable cached content and reports an update transport failure', () => {
    const first = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    expect(first).toMatchObject({ success: true });
    rmSync(repository, { recursive: true, force: true });
    const result = probe(`const deps={parsePluginSpec:()=>null,getMarketplaceRegistration:async()=>null,validateMarketplaceAccess:()=>undefined,parseMarketplaceManifest:async()=>({success:false}),updateMarketplace:async()=>[]}; console.log(JSON.stringify(await applyPluginUpdate(${JSON.stringify(source)},deps,new UpdateContext())));`);
    expect(result).toMatchObject({ success: true, changed: false, action: 'skipped' });
    expect(result.error).toContain('Failed to update cached plugin');
    expect(git('-C', first.cachePath, 'rev-parse', 'HEAD')).toBe(first.resolvedSha);
  });

  it('reports a missing remote as a transport failure', () => {
    rmSync(repository, { recursive: true, force: true });
    const result = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)})));`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to fetch plugin');
    expect(result.error).not.toContain('Invalid GitHub');
  });
});
