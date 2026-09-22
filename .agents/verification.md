# Verification

This guide expands [`AGENTS.md`](../AGENTS.md) for tests, manual E2E, code review, and completion evidence.

## Toolchain

- Runtime and package manager: Bun
- Language: TypeScript
- Tests: `bun:test`
- Lint and format: Biome

Core commands:

```bash
bun run build
bun test
bun run test:e2e
bun run typecheck
bun run lint
```

Use the narrowest command that proves the changed contract while developing. Run broader checks once the implementation is integrated.

## Tests

- Keep one test per distinct behavioral path.
- Test observable outcomes, boundaries, transitions, precedence, and real failures.
- Avoid assertions on helper calls, field forwarding, source text, or other implementation details.
- Prefer real interfaces over mocks that can drift from production behavior.
- Keep tests deterministic, isolated, and safe in the complete suite.
- Preserve a regression test for a bug when a plausible future regression would fail it. Use a throwaway smoke script instead when a permanent test would only pin plumbing.

## Manual E2E

For a bug fix, run the failing scenario before implementation and the same scenario after the fix. For a permanent feature, exercise the built user-facing path after implementation.

1. Build the CLI.
2. Create isolated project and HOME directories under `/tmp/`.
3. Configure the smallest realistic fixture that exposes the changed states.
4. Run the built CLI, not a mocked handler or globally installed binary.
5. Verify terminal output and resulting filesystem state.
6. Remove temporary fixtures after evidence is published.

Representative commands:

```bash
bun run build
./dist/index.js update
./dist/index.js plugin update
```

When test setup needs Git identity, use `git config --local` inside the temporary repository. Never change repository-root or global Git configuration for a test.

## Review and completion

For substantial changes, run a final code review after implementation and before the final green E2E. Fix correctness, ownership, and coverage findings before completion.

A branch is ready only when:

1. Every affected caller, test, and user-facing document matches the new contract.
2. Focused tests for the changed paths pass.
3. Typecheck, lint, and build pass when applicable.
4. Manual E2E proves the built behavior and filesystem result.
5. TUI changes satisfy [`.agents/tui-dogfooding.md`](tui-dogfooding.md), including durable visual evidence when required.
6. The PR description records commands, fixture setup, results, and evidence links.
7. CI is passing or the exact external blocker is documented.
