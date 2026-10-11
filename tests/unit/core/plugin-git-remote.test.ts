import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    const cached = probe(`console.log(JSON.stringify(await fetchPlugin(${JSON.stringify(source)}, {offline:true})));`);
    expect(cached.success).toBe(true);
    expect(cached.action).toBe('skipped');
    expect(cached.resolvedSha).toBe(fetched.resolvedSha);
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
