import { describe, expect, it } from 'bun:test';
import type { TuiContext } from '../context.js';
import { buildMenuOptions, type MenuAction } from '../wizard.js';

/** Helper to create a TuiContext with sensible defaults. */
function makeContext(overrides: Partial<TuiContext> = {}): TuiContext {
  return {
    hasWorkspace: false,
    workspacePath: null,
    projectPluginCount: 0,
    userPluginCount: 0,
    needsSync: false,
    hasUserConfig: false,
    marketplaceCount: 0,
    ...overrides,
  };
}

/** Extract just the action values from menu options. */
function actionValues(context: TuiContext): MenuAction[] {
  return buildMenuOptions(context).map((o) => o.value);
}

describe('buildMenuOptions', () => {
  describe('always-visible categories', () => {
    const states = [
      makeContext({ hasWorkspace: false }),
      makeContext({ hasWorkspace: true, needsSync: true }),
      makeContext({ hasWorkspace: true, needsSync: false }),
    ];

    for (const ctx of states) {
      it(`includes workspace, plugins, skills, clients, mcp, marketplace (hasWorkspace=${ctx.hasWorkspace}, needsSync=${ctx.needsSync})`, () => {
        const values = actionValues(ctx);
        expect(values).toContain('workspace');
        expect(values).toContain('plugins');
        expect(values).toContain('skills');
        expect(values).toContain('clients');
        expect(values).toContain('mcp');
        expect(values).toContain('marketplace');
      });
    }
  });

  describe('update option', () => {
    it('should show Update when an update is needed', () => {
      const context = makeContext({ hasWorkspace: true, needsSync: true });
      const values = actionValues(context);
      expect(values).toContain('sync');
    });

    it('should use Update terminology', () => {
      const context = makeContext({ hasWorkspace: true, needsSync: true });
      const options = buildMenuOptions(context);
      const updateOption = options.find((o) => o.value === 'sync');
      expect(updateOption?.label).toBe('Update');
      expect(updateOption?.hint).toBe('update needed');
    });

    it('should NOT show Update when not needed', () => {
      const context = makeContext({ hasWorkspace: true, needsSync: false });
      const values = actionValues(context);
      expect(values).not.toContain('sync');
    });

    it('should NOT show Update without workspace', () => {
      const context = makeContext({ hasWorkspace: false });
      const values = actionValues(context);
      expect(values).not.toContain('sync');
    });
  });

  describe('exit option', () => {
    it('should always be last regardless of state', () => {
      const states = [
        makeContext({ hasWorkspace: false }),
        makeContext({ hasWorkspace: true, needsSync: true }),
        makeContext({ hasWorkspace: true, needsSync: false }),
      ];
      for (const ctx of states) {
        const values = actionValues(ctx);
        expect(values[values.length - 1]).toBe('exit');
      }
    });
  });
});
