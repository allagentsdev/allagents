import {
  type ClientType,
  type McpServerConfig,
  ProfileMcpServerConfigSchema,
  ProfileMcpServerNameSchema,
} from '../../../models/workspace-config.js';
import { flattenZodIssues } from '../../../utils/zod-issues.js';
import type { ProfileSerializationInput } from '../types.js';

const SENSITIVE_QUERY_KEY =
  /(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i;
const SECRET_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Validate, target, and deterministically order profile MCP declarations. */
export function serializeProfileMcpServers(
  input: ProfileSerializationInput,
  client: ClientType,
): Record<string, McpServerConfig> | null {
  if (input.mcpServers === undefined) return null;
  const selected: Record<string, McpServerConfig> = {};
  for (const name of Object.keys(input.mcpServers).sort()) {
    const nameValidation = ProfileMcpServerNameSchema.safeParse(name);
    if (!nameValidation.success) {
      throw new Error(`Invalid profile MCP server name '${name}'`);
    }
    const parsed = ProfileMcpServerConfigSchema.safeParse(
      input.mcpServers[name],
    );
    if (!parsed.success) {
      const issue = flattenZodIssues(parsed.error)[0];
      throw new Error(
        `Invalid profile MCP server '${name}': ${issue?.message ?? 'unsupported configuration'}`,
      );
    }
    const config = parsed.data;
    if (config.clients && !config.clients.includes(client)) continue;
    if ('url' in config) {
      let url: URL;
      try {
        url = new URL(config.url);
      } catch {
        throw new Error(`Invalid profile MCP server '${name}': URL is invalid`);
      }
      if (url.username || url.password) {
        throw new Error(
          `Invalid profile MCP server '${name}': URL contains credentials`,
        );
      }
      for (const [key, value] of url.searchParams) {
        if (
          SENSITIVE_QUERY_KEY.test(key) &&
          !SECRET_REFERENCE_PATTERN.test(value)
        ) {
          throw new Error(
            `Invalid profile MCP server '${name}': secret query values must be exact \${ENV_VAR} references`,
          );
        }
      }
      const headers = config.headers
        ? Object.fromEntries(
            Object.entries(config.headers).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          )
        : undefined;
      selected[name] = {
        ...(config.type && { type: config.type }),
        url: config.url,
        ...(headers && { headers }),
      };
      continue;
    }

    const env = config.env
      ? Object.fromEntries(
          Object.entries(config.env).sort(([a], [b]) => a.localeCompare(b)),
        )
      : undefined;
    selected[name] = {
      ...(config.type && { type: config.type }),
      command: config.command,
      ...(config.args && { args: [...config.args] }),
      ...(env && { env }),
    };
  }
  return selected;
}
