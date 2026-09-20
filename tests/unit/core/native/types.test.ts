import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { executeCommand, mergeNativeSyncResults } from '../../../../src/core/native/types.js';
import type { NativeSyncResult } from '../../../../src/core/native/types.js';

describe('native/types', () => {
  describe('executeCommand', () => {
    test('returns process creation errors instead of rejecting', async () => {
      const result = await executeCommand(process.execPath, ['invalid\0argument']);

      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(result.error).toContain(`Failed to execute ${process.execPath} CLI`);
    });

    test.skipIf(process.platform !== 'win32')(
      'executes supported npm shims safely without DEP0190 on Windows',
      async () => {
        const tempDir = mkdtempSync(
          join(tmpdir(), 'allagents-execute-command-'),
        );
        const scriptDir = join(tempDir, 'node_modules', 'test-cli');
        const scriptPath = join(scriptDir, 'print-argv.cjs');
        const shimPath = join(tempDir, 'argv-recorder.cmd');
        const nestedTargetPath = join(tempDir, 'nested-target.cmd');
        const nestedShimPath = join(tempDir, 'nested-wrapper.cmd');
        const runnerPath = join(tempDir, 'run-execute-command.mjs');
        const args = [
          'value with spaces',
          'literal&operator',
          'literal|pipe',
          'literal;separator',
          'literal^caret',
          'literal%PATH%',
          'literal"quote',
          '',
          'trailing\\',
          'backslash\\"quote',
          'literal\r\nnewline',
        ];

        try {
          mkdirSync(scriptDir, { recursive: true });
          writeFileSync(
            scriptPath,
            [
              '#!/usr/bin/env node',
              "const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';",
              'const args = process.argv.slice(2);',
              'process.stdout.write(JSON.stringify({ runtime, args }));',
            ].join('\n'),
          );
          writeFileSync(
            shimPath,
            '@ECHO off\r\nnode "%~dp0\\node_modules\\test-cli\\print-argv.cjs" %*\r\n',
          );
          writeFileSync(
            join(tempDir, 'node.cmd'),
            '@ECHO off\r\nECHO unsafe interpreter selected\r\n',
          );
          writeFileSync(nestedTargetPath, '@ECHO off\r\nECHO nested batch ran\r\n');
          writeFileSync(
            nestedShimPath,
            '@ECHO off\r\n"%~dp0\\nested-target.cmd" %*\r\n',
          );

          const bundle = await Bun.build({
            entrypoints: [
              join(import.meta.dir, '../../../../src/core/native/types.ts'),
            ],
            outdir: tempDir,
            target: 'node',
            format: 'esm',
          });
          expect(bundle.success).toBe(true);
          writeFileSync(
            runnerPath,
            [
              "import { executeCommand } from './types.js';",
              "const command = process.env.ALLAGENTS_TEST_COMMAND ?? 'argv-recorder';",
              "const args = JSON.parse(process.env.ALLAGENTS_TEST_ARGS ?? '[]');",
              'const result = await executeCommand(command, args);',
              'process.stdout.write(JSON.stringify(result));',
            ].join('\n'),
          );

          const nodePath = Bun.which('node');
          if (!nodePath) {
            throw new Error('Node.js is required for the Windows argv test');
          }

          const runtimes = [
            [nodePath, '--trace-deprecation'],
            [process.execPath],
          ];
          const env = { ...process.env };
          const pathKey =
            Object.keys(env).find((key) => key.toLowerCase() === 'path') ??
            'PATH';
          const pathExtKey =
            Object.keys(env).find((key) => key.toLowerCase() === 'pathext') ??
            'PATHEXT';
          const originalPath = env[pathKey] ?? '';
          env[pathKey] = `${tempDir}${delimiter}${originalPath}`;

          for (const runtime of runtimes) {
            const proc = Bun.spawnSync([...runtime, runnerPath], {
              cwd: tempDir,
              env: {
                ...env,
                ALLAGENTS_TEST_ARGS: JSON.stringify(args),
              },
              stdout: 'pipe',
              stderr: 'pipe',
            });
            const stdout = new TextDecoder().decode(proc.stdout);
            const stderr = new TextDecoder().decode(proc.stderr);

            expect(proc.exitCode).toBe(0);
            expect(stderr).toBe('');
            expect(JSON.parse(stdout)).toEqual({
              success: true,
              output: JSON.stringify({ runtime: 'node', args }),
              exitCode: 0,
              signal: null,
            });
          }

          const nestedProc = Bun.spawnSync([nodePath, runnerPath], {
            cwd: tempDir,
            env: {
              ...env,
              ALLAGENTS_TEST_COMMAND: 'nested-wrapper',
              ALLAGENTS_TEST_ARGS: JSON.stringify(args),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const nestedResult = JSON.parse(
            new TextDecoder().decode(nestedProc.stdout),
          );
          expect(nestedProc.exitCode).toBe(0);
          expect(new TextDecoder().decode(nestedProc.stderr)).toBe('');
          expect(nestedResult).toMatchObject({
            success: false,
            output: '',
          });
          expect(nestedResult.error).toContain(
            `cannot safely execute command shim target '${nestedTargetPath}'`,
          );

          writeFileSync(
            join(tempDir, 'node.com'),
            'This must not run when PATHEXT excludes .COM',
          );
          const filteredPathExtProc = Bun.spawnSync(
            [process.execPath, runnerPath],
            {
              cwd: tempDir,
              env: {
                ...env,
                [pathExtKey]: '.CMD;.EXE',
                ALLAGENTS_TEST_ARGS: JSON.stringify(args),
              },
              stdout: 'pipe',
              stderr: 'pipe',
            },
          );
          expect(filteredPathExtProc.exitCode).toBe(0);
          expect(
            new TextDecoder().decode(filteredPathExtProc.stderr),
          ).toBe('');
          expect(
            JSON.parse(new TextDecoder().decode(filteredPathExtProc.stdout)),
          ).toEqual({
            success: true,
            output: JSON.stringify({ runtime: 'node', args }),
            exitCode: 0,
            signal: null,
          });

          const cwdFallbackProc = Bun.spawnSync(
            [process.execPath, runnerPath],
            {
              cwd: tempDir,
              env: {
                ...env,
                [pathKey]: `${originalPath}${delimiter}`,
                ALLAGENTS_TEST_COMMAND: 'nested-wrapper',
              },
              stdout: 'pipe',
              stderr: 'pipe',
            },
          );
          const cwdFallbackResult = JSON.parse(
            new TextDecoder().decode(cwdFallbackProc.stdout),
          );
          expect(cwdFallbackProc.exitCode).toBe(0);
          expect(new TextDecoder().decode(cwdFallbackProc.stderr)).toBe('');
          expect(cwdFallbackResult).toMatchObject({
            success: false,
            output: '',
          });
          expect(cwdFallbackResult.error).toContain(
            'command not found on PATH: nested-wrapper',
          );
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
      15_000,
    );
  });

  describe('mergeNativeSyncResults', () => {
    test('preserves ordered effects and aggregate failure', () => {
      const resource = {
        kind: 'plugin' as const,
        requestedIdentity: 'p1@repo',
        resolvedIdentity: 'p1@repo',
        context: {
          client: 'claude',
          scope: 'project' as const,
          nativeScope: 'project',
          root: '/workspace',
        },
        provenance: {},
      };
      const a: NativeSyncResult = {
        success: true,
        effects: [{ action: 'installed', resource }],
      };
      const b: NativeSyncResult = {
        success: false,
        effects: [{ action: 'failed', resource, error: 'fail' }],
      };

      expect(mergeNativeSyncResults([a, b])).toEqual({
        success: false,
        effects: [...a.effects, ...b.effects],
      });
    });

    test('returns a successful empty result', () => {
      expect(mergeNativeSyncResults([])).toEqual({
        success: true,
        effects: [],
      });
    });
  });
});
