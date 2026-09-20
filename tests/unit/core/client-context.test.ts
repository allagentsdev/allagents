import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  resolveClientContext,
  resolveClientContexts,
} from '../../../src/core/client-context.js';
import {
  CLIENT_MAPPINGS,
  USER_CLIENT_MAPPINGS,
  clientIdsForScope,
} from '../../../src/models/client-mapping.js';

describe('resolveClientContext', () => {
  const homeDir = '/users/tester';
  const cwd = '/work/repo/packages/app';
  const repoRoot = '/work/repo';

  describe('Pi', () => {
    it('uses the native default user root and shared user discovery root', () => {
      const context = resolveClientContext('pi', 'user', {
        homeDir,
        cwd,
        env: {
          XDG_DATA_HOME: '/xdg/data',
          XDG_STATE_HOME: '/xdg/state',
          XDG_CACHE_HOME: '/xdg/cache',
        },
      });

      expect(context.writeRoot).toBe('/users/tester/.pi/agent');
      expect(context.mapping).toEqual(USER_CLIENT_MAPPINGS.pi);
      expect(context.skillDiscoveryRoots).toEqual([
        '/users/tester/.pi/agent/skills',
        '/users/tester/.agents/skills',
      ]);
    });

    it('resolves an absolute PI_CODING_AGENT_DIR without unsafe relative mapping', () => {
      const context = resolveClientContext('pi', 'user', {
        homeDir,
        cwd,
        env: { PI_CODING_AGENT_DIR: '/external/pi-agent' },
      });

      expect(context.writeRoot).toBe('/external/pi-agent');
      expect(context.mapping.skillsPath).toBe('/external/pi-agent/skills/');
      expect(context.mapping.skillsPath).not.toContain('..');
    });

    it('resolves a relative PI_CODING_AGENT_DIR from the runtime cwd', () => {
      const context = resolveClientContext('pi', 'user', {
        homeDir,
        cwd,
        env: { PI_CODING_AGENT_DIR: '../selected-pi' },
      });

      expect(context.writeRoot).toBe('/work/repo/packages/selected-pi');
      expect(context.mapping.skillsPath).toBe(
        '/work/repo/packages/selected-pi/skills/',
      );
    });

    it('uses the cwd native root before shared ancestors and stops at the repository boundary', () => {
      const context = resolveClientContext('pi', 'project', {
        homeDir,
        cwd,
        repoRoot,
        env: {},
      });

      expect(context.skillDiscoveryRoots).toEqual([
        '/work/repo/packages/app/.pi/skills',
        '/work/repo/packages/app/.agents/skills',
        '/work/repo/packages/.agents/skills',
        '/work/repo/.agents/skills',
      ]);
    });
  });

  describe('OMP', () => {
    it('uses the ordinary default roots and ignores ambient named profiles', () => {
      const context = resolveClientContext('omp', 'user', {
        homeDir,
        cwd,
        env: {
          OMP_PROFILE: 'work',
          PI_PROFILE: 'legacy',
          PI_CONFIG_FILES: '/tmp/profile.yml',
        },
        platform: 'linux',
        pathExists: () => false,
      });

      expect(context.writeRoot).toBe('/users/tester/.omp/agent');
      expect(context.mapping).toEqual(USER_CLIENT_MAPPINGS.omp);
      expect(context.commandEnv.OMP_PROFILE).toBeUndefined();
      expect(context.commandEnv.PI_PROFILE).toBeUndefined();
      expect(context.commandEnv.PI_CONFIG_FILES).toBeUndefined();
    });

    it('honors PI_CONFIG_DIR for the default user agent root', () => {
      const context = resolveClientContext('omp', 'user', {
        homeDir,
        cwd,
        env: { PI_CONFIG_DIR: '.config/omp-custom' },
        platform: 'linux',
        pathExists: () => false,
      });

      expect(context.ompRoots?.config).toBe(
        '/users/tester/.config/omp-custom',
      );
      expect(context.writeRoot).toBe(
        '/users/tester/.config/omp-custom/agent',
      );
      expect(context.mapping.skillsPath).toBe(
        '.config/omp-custom/agent/skills/',
      );
    });

    it('activates each existing XDG category independently', () => {
      const existing = new Set(['/xdg/data/omp', '/xdg/cache/omp']);
      const context = resolveClientContext('omp', 'user', {
        homeDir,
        cwd,
        env: {
          XDG_DATA_HOME: '/xdg/data',
          XDG_STATE_HOME: '/xdg/state',
          XDG_CACHE_HOME: '/xdg/cache',
        },
        platform: 'linux',
        pathExists: (path) => existing.has(path),
      });

      expect(context.ompRoots).toEqual({
        config: '/users/tester/.omp',
        agent: '/users/tester/.omp/agent',
        data: '/xdg/data/omp',
        state: '/users/tester/.omp',
        cache: '/xdg/cache/omp',
        dataAgent: '/xdg/data/omp',
        stateAgent: '/users/tester/.omp/agent',
        cacheAgent: '/xdg/cache/omp',
      });
    });

    it('does not activate missing XDG targets or XDG with an agent override', () => {
      const missing = resolveClientContext('omp', 'user', {
        homeDir,
        cwd,
        env: { XDG_DATA_HOME: '/xdg/data' },
        platform: 'linux',
        pathExists: () => false,
      });
      expect(missing.ompRoots?.data).toBe('/users/tester/.omp');

      const overridden = resolveClientContext('omp', 'user', {
        homeDir,
        cwd,
        env: {
          PI_CODING_AGENT_DIR: '/external/omp-agent',
          XDG_DATA_HOME: '/xdg/data',
        },
        platform: 'linux',
        pathExists: () => true,
      });
      expect(overridden.ompRoots?.data).toBe('/users/tester/.omp');
      expect(overridden.writeRoot).toBe('/external/omp-agent');
      expect(overridden.mapping.skillsPath).toBe(
        '/external/omp-agent/skills/',
      );
    });

    it('resolves a relative PI_CODING_AGENT_DIR from the runtime cwd', () => {
      const context = resolveClientContext('omp', 'user', {
        homeDir,
        cwd,
        env: { PI_CODING_AGENT_DIR: '../selected-omp' },
        platform: 'linux',
        pathExists: () => false,
      });

      expect(context.writeRoot).toBe('/work/repo/packages/selected-omp');
      expect(context.mapping.skillsPath).toBe(
        '/work/repo/packages/selected-omp/skills/',
      );
    });

    it('orders native then legacy/shared project roots within the boundary', () => {
      const context = resolveClientContext('omp', 'project', {
        homeDir,
        cwd,
        repoRoot,
        env: {},
        platform: 'linux',
        pathExists: () => false,
      });

      expect(context.skillDiscoveryRoots).toEqual([
        '/work/repo/packages/app/.omp/skills',
        '/work/repo/packages/.omp/skills',
        '/work/repo/.omp/skills',
        '/work/repo/packages/app/.agent/skills',
        '/work/repo/packages/app/.agents/skills',
        '/work/repo/packages/.agent/skills',
        '/work/repo/packages/.agents/skills',
        '/work/repo/.agent/skills',
        '/work/repo/.agents/skills',
      ]);
    });
  });

  it('preserves every ordinary client mapping and root', () => {
    const projectClients = clientIdsForScope('project').filter(
      (client) => client !== 'pi' && client !== 'omp',
    );
    const userClients = clientIdsForScope('user').filter(
      (client) => client !== 'pi' && client !== 'omp',
    );
    const project = resolveClientContexts(projectClients, 'project', {
      homeDir,
      cwd: repoRoot,
      env: {},
    });
    const user = resolveClientContexts(userClients, 'user', {
      homeDir,
      cwd,
      env: {},
    });

    for (const client of projectClients) {
      expect(project.get(client)?.writeRoot).toBe(resolve(repoRoot));
      expect(project.get(client)?.mapping).toBe(CLIENT_MAPPINGS[client]);
    }
    for (const client of userClients) {
      expect(user.get(client)?.writeRoot).toBe(resolve(homeDir));
      expect(user.get(client)?.mapping).toBe(USER_CLIENT_MAPPINGS[client]);
      expect(user.get(client)?.skillDiscoveryRoots).toEqual([
        resolve(homeDir, USER_CLIENT_MAPPINGS[client]?.skillsPath ?? ''),
      ]);
    }
  });

  it('rejects a project-only client before resolving a user destination', () => {
    expect(() =>
      resolveClientContext('eve', 'user', { homeDir, cwd, env: {} }),
    ).toThrow("Client 'eve' does not support user scope");
  });
});
