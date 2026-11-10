import packageJson from '../../package.json';
import {
  isMcpCredentialField,
  type McpConnectionConfig,
  type McpOAuthConfig,
} from '../models/mcp-options.js';
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
): config is Extract<McpServerConfig, { url: string }> {
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
  clientName?: string,
  oauth?: McpOAuthConfig,
  connection?: McpConnectionConfig,
): McpServerConfig {
  const args = ['-y', `allagents@${packageJson.version}`, 'mcp', 'proxy', url];
  const env: Record<string, string> = {};
  // Reserve authored names before allocating bindings, including names used in
  // other fields, so generated credentials cannot overwrite caller references.
  for (const match of JSON.stringify({ oauth, headers }).matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
  )) {
    const variable = match[1] as string;
    env[variable] = `\${${variable}}`;
  }
  const bindCredential = (value: string, base: string): string => {
    const reference = ENVIRONMENT_REFERENCE.exec(value);
    if (reference) return value;
    let variable = base;
    let suffix = 2;
    while (Object.hasOwn(env, variable)) variable = `${base}_${suffix++}`;
    env[variable] = value;
    return `\${${variable}}`;
  };
  if (profile) {
    args.push('--profile', ProfileNameSchema.parse(profile));
  }
  if (clientName !== undefined) {
    args.push('--oauth-client-name', clientName);
  }
  if (oauth && Object.keys(oauth).some((key) => key !== 'clientName')) {
    const portableOAuth = { ...oauth };
    if (portableOAuth.clientSecret !== undefined) {
      portableOAuth.clientSecret = bindCredential(
        portableOAuth.clientSecret,
        'ALLAGENTS_MCP_OAUTH_CLIENT_SECRET',
      );
    }
    if (portableOAuth.authorizationParams) {
      portableOAuth.authorizationParams = Object.fromEntries(
        Object.entries(portableOAuth.authorizationParams).map(
          ([key, value]) => [
            key,
            isMcpCredentialField(key)
              ? bindCredential(
                  value,
                  `ALLAGENTS_MCP_OAUTH_PARAM_${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`,
                )
              : value,
          ],
        ),
      );
    }
    // Hosts must pass bridge-owned references through literally. JSON.parse in
    // the bridge decodes these escapes once, before OAuth resolves its values.
    args.push(
      '--oauth-config',
      JSON.stringify(portableOAuth).replace(/\$/g, '\\u0024'),
    );
  }
  if (connection !== undefined)
    args.push('--connection-config', JSON.stringify(connection));
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
  config: McpProxyConfig = { clients: [] },
  options: { profile?: string } = {},
): Map<string, T | McpServerConfig> {
  const result = new Map<string, T | McpServerConfig>();
  for (const [name, serverConfig] of servers) {
    if (
      isHttpServer(serverConfig) &&
      (shouldProxy(name, client, config) ||
        serverConfig.oauth !== undefined ||
        serverConfig.connection !== undefined)
    ) {
      result.set(
        name,
        toProxiedConfig(
          serverConfig.url,
          serverConfig.headers,
          options.profile,
          serverConfig.oauth?.clientName,
          serverConfig.oauth,
          serverConfig.connection,
        ),
      );
    } else {
      result.set(name, serverConfig);
    }
  }
  return result;
}
