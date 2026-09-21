import { z } from 'zod';
import { ClientTypeSchema, ProfileNameSchema } from './workspace-config.js';

export const ProfileSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ProfileResourceKindSchema = z.enum([
  'root',
  'file',
  'settings',
  'mcp',
  'native',
  'marketplace',
  'launcher',
]);

export const ProfileResourceOwnershipSchema = z.enum(['managed', 'referenced']);

export const ProfileResourceTransitionSchema = z.enum([
  'planned',
  'pending-install',
  'installed',
  'pending-update',
  'updated',
  'referenced',
  'retained',
  'pending-remove',
  'removed',
  'cleanup-failed',
  'failed',
]);

export const ProfileCleanupMechanismSchema = z.enum([
  'none',
  'file',
  'native',
  'marketplace',
  'launcher',
]);

const SENSITIVE_KEY =
  /(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i;

function containsSecretUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) return false;
    if (url.username || url.password) return true;
    return [...url.searchParams.keys()].some((key) => SENSITIVE_KEY.test(key));
  } catch {
    return false;
  }
}

function containsSecretUrlInText(value: string): boolean {
  const urls = value.match(/\b(?:https?|ssh):\/\/[^\s'"<>]+/gi) ?? [];
  return urls.some(containsSecretUrl);
}
function containsUnsafeControl(value: string, allowWhitespace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5b) return true;
    if (code === 0x7f) return true;
    if (
      code <= 0x1f &&
      !(allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d))
    ) {
      return true;
    }
  }
  return false;
}


const SanitizedStringSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !containsUnsafeControl(value),
    'must not contain control sequences',
  )
  .refine(
    (value) => !containsSecretUrl(value),
    'must not contain URL credentials or secret query parameters',
  )
  .refine(
    (value) => !/\bbearer\s+\S+/i.test(value),
    'must not contain bearer credentials',
  )
  .refine(
    (value) =>
      !/\b(?:authorization|credential|password|secret|token|api[-_]?key)\s*[:=]\s*\S+/i.test(
        value,
      ),
    'must not contain credential assignments',
  );

const SanitizedErrorSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !containsUnsafeControl(value, true),
    'must not contain terminal control sequences',
  )
  .refine(
    (value) => !containsSecretUrlInText(value),
    'must not contain URL credentials or secret query parameters',
  )
  .refine(
    (value) => !/\bbearer\s+(?!\[REDACTED\])\S+/i.test(value),
    'must not contain bearer credentials',
  )
  .refine(
    (value) =>
      !/\b(?:authorization|credential|password|secret|token|api[-_]?key)\s*[:=]\s*(?!\[REDACTED\])\S+/i.test(
        value,
      ),
    'must not contain credential assignments',
  );

const SanitizedProvenanceSchema = z
  .record(z.string(), SanitizedStringSchema)
  .superRefine((record, context) => {
    for (const key of Object.keys(record)) {
      if (SENSITIVE_KEY.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'secret provenance keys are not permitted in profile state',
        });
      }
    }
  });

export const ProfileResourceRelationshipSchema = z
  .object({
    key: SanitizedStringSchema,
    client: ClientTypeSchema,
    kind: ProfileResourceKindSchema,
    /** Runtime-native identity or absolute path identity for this resource. */
    identity: SanitizedStringSchema,
    /** Concrete absolute path when the resource has a filesystem location. */
    path: SanitizedStringSchema.optional(),
    ownership: ProfileResourceOwnershipSchema,
    transition: ProfileResourceTransitionSchema,
    fingerprint: ProfileSha256Schema.optional(),
    cleanup: ProfileCleanupMechanismSchema,
    requestedRef: SanitizedStringSchema.optional(),
    resolvedRef: SanitizedStringSchema.optional(),
    provenance: SanitizedProvenanceSchema.optional(),
    error: SanitizedErrorSchema.optional(),
  })
  .strict();

export const ProfileClientStatusSchema = z
  .object({
    client: ClientTypeSchema,
    status: z.enum(['installed', 'partial']),
    error: SanitizedErrorSchema.optional(),
  })
  .strict();

export const ProfileOperationSchema = z
  .object({
    id: SanitizedStringSchema,
    kind: z.enum(['install', 'update', 'remove']),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export const ProfileStateSchema = z
  .object({
    version: z.literal(1),
    profile: ProfileNameSchema,
    clients: z.array(ClientTypeSchema).min(1),
    declarationDigest: ProfileSha256Schema,
    status: z.enum(['installed', 'partial']),
    /** Per-client progress in the same stable order as clients. */
    clientStatuses: z.array(ProfileClientStatusSchema),
    operation: ProfileOperationSchema,
    /** Stable insertion order is preserved across relationship checkpoints. */
    resources: z.array(ProfileResourceRelationshipSchema),
  })
  .strict()
  .superRefine((state, context) => {
    const clientSet = new Set(state.clients);
    if (clientSet.size !== state.clients.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clients'],
        message: 'profile state clients must be unique',
      });
    }
    if (
      state.clientStatuses.length !== state.clients.length ||
      state.clientStatuses.some(
        (entry, index) => entry.client !== state.clients[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clientStatuses'],
        message: 'client statuses must occur once in the same order as profile clients',
      });
    }
    const allClientsInstalled = state.clientStatuses.every(
      (entry) => entry.status === 'installed',
    );
    if ((state.status === 'installed') !== allClientsInstalled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'profile status must be installed only when every client is installed',
      });
    }


    const keys = new Set<string>();
    for (let index = 0; index < state.resources.length; index++) {
      const resource = state.resources[index];
      if (!resource) continue;
      if (!clientSet.has(resource.client)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resources', index, 'client'],
          message: 'resource client must be included in profile state clients',
        });
      }
      if (keys.has(resource.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resources', index, 'key'],
          message: 'resource relationship keys must be unique',
        });
      }
      keys.add(resource.key);
    }
  });

export type ProfileSha256 = z.infer<typeof ProfileSha256Schema>;
export type ProfileResourceKind = z.infer<typeof ProfileResourceKindSchema>;
export type ProfileResourceOwnership = z.infer<typeof ProfileResourceOwnershipSchema>;
export type ProfileResourceTransition = z.infer<typeof ProfileResourceTransitionSchema>;
export type ProfileCleanupMechanism = z.infer<typeof ProfileCleanupMechanismSchema>;
export type ProfileResourceRelationship = z.infer<typeof ProfileResourceRelationshipSchema>;
export type ProfileClientStatus = z.infer<typeof ProfileClientStatusSchema>;
export type ProfileOperation = z.infer<typeof ProfileOperationSchema>;
export type ProfileState = z.infer<typeof ProfileStateSchema>;
