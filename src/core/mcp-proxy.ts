import packageJson from '../../package.json';
import {
  type McpProxyConfig,
  type McpServerConfig,
  ProfileNameSchema,
} from '../models/workspace-config.js';

const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Determine if a server+client pair should be proxied.
 */
export function shouldProxy(
  serverName: string,
  client: string,
  config: McpProxyConfig,
): boolean {
  if (config.clients.includes(client)) {
    return true;
  }
  const serverOverride = config.servers?.[serverName];
  if (
    serverOverride?.proxy.includes('*') ||
    serverOverride?.proxy.includes(client)
  ) {
    return true;
  }
  return false;
}

/**
 * Check if a server config uses HTTP transport (has a `url` field).
 */
function isHttpServer(
  config: unknown,
): config is { url: string; headers?: Record<string, string> } {
  return (
    typeof config === 'object' &&
    config !== null &&
    'url' in config &&
    typeof (config as Record<string, unknown>).url === 'string'
  );
}

/**
 * Rewrite an HTTP server config to a stdio config using the built-in
 * AllAgents HTTP-to-stdio proxy helper.
 */
function toProxiedConfig(
  url: string,
  headers?: Record<string, string>,
  profile?: string,
): McpServerConfig {
  const args = ['-y', `allagents@${packageJson.version}`, 'mcp', 'proxy', url];
  const env: Record<string, string> = {};
  if (profile) {
    args.push('--profile', ProfileNameSchema.parse(profile));
  }
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      const reference = ENVIRONMENT_REFERENCE.exec(value);
      if (reference) {
        const variable = reference[1] as string;
        args.push('--header-env', `${key}=${variable}`);
        env[variable] = value;
      } else {
        args.push('--header', `${key}=${value}`);
      }
    }
  }

  return {
    command: 'npx',
    args,
    ...(Object.keys(env).length > 0 && { env }),
  };
}

/**
 * Apply MCP proxy transform to collected servers for a given client.
 * Returns a new Map with HTTP configs rewritten to stdio where applicable.
 * Non-HTTP servers and non-proxied clients are passed through unchanged.
 */
export function applyMcpProxy<T>(
  servers: Map<string, T>,
  client: string,
  config: McpProxyConfig,
  options: { profile?: string } = {},
): Map<string, T | McpServerConfig> {
  const result = new Map<string, T | McpServerConfig>();
  for (const [name, serverConfig] of servers) {
    if (isHttpServer(serverConfig) && shouldProxy(name, client, config)) {
      result.set(
        name,
        toProxiedConfig(
          serverConfig.url,
          serverConfig.headers,
          options.profile,
        ),
      );
    } else {
      result.set(name, serverConfig);
    }
  }
  return result;
}
