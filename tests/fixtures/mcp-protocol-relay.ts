import { runHttpMcpStdioProxy } from '../../src/core/mcp-http-stdio-proxy.js';
await runHttpMcpStdioProxy(process.argv[2] as string, {}, process.argv[3] ? JSON.parse(process.argv[3]) : {});
