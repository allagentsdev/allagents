import { connectMcpHttpClient } from '../../src/core/mcp-http-client.js';
const connection = await connectMcpHttpClient(process.argv[2] as string, {
  environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' }, authorizationOutput: () => {},
  callbackUrlReader: async ({ authorizationUrl }) => {
    const response = await fetch(authorizationUrl, { redirect: 'manual' });
    return response.headers.get('location') as string;
  },
});
try { await connection.client.callTool({ name: 'protected' }); console.log('success'); }
finally { await connection.close(); }
