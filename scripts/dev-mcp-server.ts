#!/usr/bin/env bun
import { startDummyMcpOAuthServer } from '../tests/helpers/dummy-mcp-oauth-server.ts';

async function main() {
  const server = await startDummyMcpOAuthServer();

  console.log('Local dummy MCP + OAuth server running:');
  console.log(`  MCP endpoint: ${server.mcpUrl}`);
  console.log(`  OAuth issuer: ${server.idpIssuer}`);
  console.log('');
  console.log('Point allagents at it, e.g.:');
  console.log(`  allagents mcp add local-dev ${server.mcpUrl}`);
  console.log(`  bun run scripts/smoke-mcp-oauth.ts ${server.mcpUrl}`);
  console.log('');
  console.log(
    'Authorization requests auto-approve immediately (no login screen) -- this is a',
  );
  console.log('CI-safe test double, not a real identity provider.');
  console.log('');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(
    'Failed to start dev MCP server:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
