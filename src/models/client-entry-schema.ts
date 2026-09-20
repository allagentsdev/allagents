import { z } from 'zod';
import {
  CLIENT_ALIASES,
  CLIENT_TYPES,
  USER_CLIENT_TYPES,
  canonicalizeClientId,
  type CanonicalClientId,
} from './client-mapping.js';

export { CLIENT_TYPES, USER_CLIENT_TYPES } from './client-mapping.js';

export type ClientType = CanonicalClientId;

export const CanonicalClientTypeSchema = z.enum(CLIENT_TYPES);

const CLIENT_ALIAS_TYPES = Object.keys(CLIENT_ALIASES) as [
  keyof typeof CLIENT_ALIASES,
  ...(keyof typeof CLIENT_ALIASES)[],
];

export const CLIENT_INPUT_TYPES = [
  ...CLIENT_TYPES,
  ...CLIENT_ALIAS_TYPES,
] as const;

function requireCanonicalClientId(input: string): ClientType {
  const canonical = canonicalizeClientId(input);
  if (!canonical) throw new Error(`Unknown client '${input}'`);
  return canonical;
}

/** Accepts canonical IDs and public aliases; output is always canonical. */
export const ClientTypeSchema = z
  .enum(CLIENT_INPUT_TYPES)
  .transform(requireCanonicalClientId);

const USER_CLIENT_ALIAS_TYPES = CLIENT_ALIAS_TYPES.filter((alias) =>
  USER_CLIENT_TYPES.includes(CLIENT_ALIASES[alias]),
) as [keyof typeof CLIENT_ALIASES, ...(keyof typeof CLIENT_ALIASES)[]];

const USER_CLIENT_INPUT_TYPES = [
  ...USER_CLIENT_TYPES,
  ...USER_CLIENT_ALIAS_TYPES,
] as const;

export const UserClientTypeSchema = z
  .enum(USER_CLIENT_INPUT_TYPES, {
    errorMap: (issue, context) => {
      if (
        issue.code !== z.ZodIssueCode.invalid_enum_value ||
        typeof issue.received !== 'string'
      ) {
        return { message: context.defaultError };
      }
      const canonical = canonicalizeClientId(issue.received);
      return {
        message:
          canonical && !USER_CLIENT_TYPES.includes(canonical)
            ? `Client '${issue.received}' does not support user scope`
            : `Unknown client '${issue.received}'`,
      };
    },
  })
  .transform(requireCanonicalClientId);

/**
 * Free-form selectors retain unknown values for forward compatibility while
 * normalizing every client identity this version recognizes. Duplicates remain
 * visible so profile validation can reject alias-equivalent declarations.
 */
export const ClientSelectorListSchema = z.array(
  z.string().transform((value) => canonicalizeClientId(value) ?? value),
);

function deduplicateClientTypes(clients: readonly ClientType[]): ClientType[] {
  return [...new Set(clients)];
}

export const ClientTypeListSchema = z
  .array(ClientTypeSchema)
  .transform(deduplicateClientTypes);

export const UserClientTypeListSchema = z
  .array(UserClientTypeSchema)
  .transform(deduplicateClientTypes);

export const InstallModeSchema = z.enum(['file', 'native']);
export type InstallMode = z.infer<typeof InstallModeSchema>;

const CLIENT_INSTALL_SHORTHANDS = CLIENT_INPUT_TYPES.flatMap((client) =>
  InstallModeSchema.options.map((install) => `${client}:${install}` as const),
) as [string, ...string[]];

const USER_CLIENT_INSTALL_SHORTHANDS = USER_CLIENT_INPUT_TYPES.flatMap(
  (client) =>
    InstallModeSchema.options.map((install) => `${client}:${install}` as const),
) as [string, ...string[]];

function parseInstallShorthand(value: string): {
  name: ClientType;
  install: InstallMode;
} {
  const separator = value.lastIndexOf(':');
  return {
    name: requireCanonicalClientId(value.slice(0, separator)),
    install: value.slice(separator + 1) as InstallMode,
  };
}

const ClientInstallShorthandSchema = z
  .enum(CLIENT_INSTALL_SHORTHANDS)
  .transform(parseInstallShorthand);

const UserClientInstallShorthandSchema = z
  .enum(USER_CLIENT_INSTALL_SHORTHANDS)
  .transform(parseInstallShorthand);

export const ClientEntrySchema = z.union([
  ClientTypeSchema,
  ClientInstallShorthandSchema,
  z.object({
    name: ClientTypeSchema,
    install: InstallModeSchema.default('file'),
  }),
]);

const UserClientEntrySchema = z.union([
  UserClientTypeSchema,
  UserClientInstallShorthandSchema,
  z.object({
    name: UserClientTypeSchema,
    install: InstallModeSchema.default('file'),
  }),
]);

export type ClientEntry = z.infer<typeof ClientEntrySchema>;

export function normalizeClientEntry(entry: ClientEntry): {
  name: ClientType;
  install: InstallMode;
} {
  if (typeof entry === 'string') {
    return { name: entry, install: 'file' };
  }
  return { name: entry.name, install: entry.install ?? 'file' };
}

/** Preserve first-entry install precedence while preventing duplicate writes. */
export function deduplicateClientEntries(
  entries: readonly ClientEntry[],
): ClientEntry[] {
  const seen = new Set<ClientType>();
  const deduplicated: ClientEntry[] = [];
  for (const entry of entries) {
    const { name } = normalizeClientEntry(entry);
    if (seen.has(name)) continue;
    seen.add(name);
    deduplicated.push(entry);
  }
  return deduplicated;
}

export const ClientEntryListSchema = z
  .array(ClientEntrySchema)
  .transform(deduplicateClientEntries);

export const UserClientEntryListSchema = z
  .array(UserClientEntrySchema)
  .transform(deduplicateClientEntries);

export function getClientTypes(entries: readonly ClientEntry[]): ClientType[] {
  const clients = new Set<ClientType>();
  for (const entry of entries) {
    clients.add(normalizeClientEntry(entry).name);
  }
  return [...clients];
}

export function getClientInstallMode(
  entries: readonly ClientEntry[],
  client: ClientType,
): InstallMode {
  for (const entry of entries) {
    const normalized = normalizeClientEntry(entry);
    if (normalized.name === client) return normalized.install;
  }
  return 'file';
}
