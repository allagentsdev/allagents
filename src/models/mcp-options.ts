import { z } from 'zod';

const timeout = z.number().finite().nonnegative();
const nonempty = z.string().trim().min(1);

/** Credential names shared by portable profile validation and bridge generation. */
export function isMcpCredentialField(name: string): boolean {
  return /(?:^|[-_.])(?:api[-_]?key|auth|authorization|credential|key|password|secret|signature|token)(?:$|[-_.])/i.test(
    name,
  );
}

export const McpOAuthConfigSchema = z
  .object({
    clientName: nonempty.optional(),
    clientId: nonempty.optional(),
    clientSecret: z.string().min(1).optional(),
    scope: z.string().optional(),
    clientMetadata: z.record(z.string(), z.unknown()).optional(),
    clientMetadataUrl: z.url().optional(),
    issuer: z.url().optional(),
    allowHttp: z.boolean().optional(),
    resource: z.string().optional(),
    authorizationParams: z.record(z.string(), z.string()).optional(),
    disableResourceParameter: z.boolean().optional(),
    grantType: z
      .enum(['authorization_code', 'device_code', 'client_credentials'])
      .optional(),
    tokenEndpoint: z.url().optional(),
    useIdToken: z.boolean().optional(),
    callback: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        host: nonempty.optional(),
        bindHost: nonempty.optional(),
        path: z.string().startsWith('/').optional(),
        timeoutSeconds: z.number().finite().positive().optional(),
        successUrl: z.url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.grantType === 'client_credentials' && !config.clientId) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientId'],
        message: 'Client credentials authorization requires a client ID',
      });
    }
    if (config.tokenEndpoint && config.grantType !== 'client_credentials') {
      ctx.addIssue({
        code: 'custom',
        path: ['tokenEndpoint'],
        message:
          'An explicit token endpoint requires the client credentials grant',
      });
    }
    if (config.clientSecret && !config.clientId) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientId'],
        message: 'A client secret requires a client ID',
      });
    }
    const reserved = new Set([
      'code',
      'client_secret',
      'access_token',
      'refresh_token',
      'id_token',
      'token',
      'state',
      'client_id',
      'redirect_uri',
      'response_type',
      'code_challenge',
      'code_challenge_method',
    ]);
    for (const key of Object.keys(config.authorizationParams ?? {})) {
      if (reserved.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['authorizationParams', key],
          message: 'This authorization parameter is managed by the OAuth flow',
        });
    }
  });

export const McpConnectionConfigSchema = z
  .object({
    transportStrategy: z
      .enum(['http-first', 'sse-first', 'http-only', 'sse-only'])
      .optional(),
    protocol: z.enum(['legacy', 'auto']).optional(),
    ignoreTools: z.array(nonempty).optional(),
    connectTimeoutSeconds: timeout.optional(),
    headersTimeoutSeconds: timeout.optional(),
    bodyTimeoutSeconds: timeout.optional(),
    keepAliveSeconds: z.number().finite().positive().optional(),
    ipv4: z.boolean().optional(),
    enableProxy: z.boolean().optional(),
    disableCookies: z.boolean().optional(),
    debug: z.boolean().optional(),
    silent: z.boolean().optional(),
  })
  .strict();

export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;
export type McpConnectionConfig = z.infer<typeof McpConnectionConfigSchema>;
