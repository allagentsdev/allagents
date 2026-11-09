import { runHttpMcpStdioProxy } from '../../src/core/mcp-http-stdio-proxy.js';

await runHttpMcpStdioProxy(process.argv[2] as string, {}, {
  oauth: { clientId: 'pre-registered' },
  environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
  authorizationOutput: () => {},
  callbackUrlReader: ({ redirectUrl, signal }) => new Promise((_resolve, reject) => {
    console.error(`CALLBACK_READY ${redirectUrl}`);
    signal.addEventListener('abort', () => reject(new Error('Fixture consent was cancelled')), { once: true });
  }),
});
