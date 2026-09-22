import type { z } from 'zod';

/**
 * Issue codes produced by a union branch whose input matched the branch shape
 * but carried extra keys or failed a branch refinement.
 *
 * Zod 3 reported these as the union's own error (`ZodUnion` returned the first
 * "dirty" option's issues); Zod 4 collapses every branch into one generic
 * `invalid_union` issue, so callers must unpack the branches themselves.
 */
const STRUCTURAL_ISSUE_CODES: Record<string, true> = {
  unrecognized_keys: true,
  custom: true,
};

type NestedIssue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly errors?: readonly (readonly NestedIssue[])[];
  readonly issues?: readonly NestedIssue[];
};

function structuralBranch(
  branches: readonly (readonly NestedIssue[])[],
): readonly NestedIssue[] | undefined {
  return branches.find(
    (branch) =>
      branch.length > 0 &&
      branch.every((issue) => STRUCTURAL_ISSUE_CODES[issue.code] === true),
  );
}

/**
 * Flatten a `ZodError` into the leaf issues a caller can show to a user.
 *
 * Zod 4 nests the failures of a schema it treats as a single step:
 * `z.union` hides every branch inside `errors`, and `z.record` hides key
 * failures inside `issues`. Without unpacking them, callers that map
 * `error.issues` lose the failing field path and the message the schema
 * author wrote.
 */
export function flattenZodIssues(error: z.ZodError): z.ZodIssue[] {
  const leaves = new Map<string, NestedIssue>();

  const add = (issue: NestedIssue): void => {
    leaves.set(`${issue.path.join('.')}|${issue.code}|${issue.message}`, issue);
  };

  const visit = (issue: NestedIssue, prefix: readonly PropertyKey[]): void => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union') {
      const branch = structuralBranch(issue.errors ?? []);
      if (!branch) {
        add({ ...issue, path });
        return;
      }
      for (const nested of branch) visit(nested, path);
      return;
    }
    if (issue.code === 'invalid_key' && issue.issues && issue.issues.length > 0) {
      for (const nested of issue.issues) visit(nested, path);
      return;
    }
    add({ ...issue, path });
  };

  for (const issue of error.issues) {
    visit(issue as NestedIssue, []);
  }
  return [...leaves.values()] as unknown as z.ZodIssue[];
}