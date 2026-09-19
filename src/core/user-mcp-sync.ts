import type { SyncState } from '../models/sync-state.js';
import type {
  ClientType,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import {
  syncClaudeMcpConfig,
  syncClaudeMcpServersViaCli,
} from './claude-mcp.js';
import { syncCodexMcpServers } from './codex-mcp.js';
import { getCopilotMcpConfigPath } from './copilot-mcp.js';
import { applyMcpProxy } from './mcp-proxy.js';
import type { ValidatedPlugin } from './sync.js';
import { getPreviouslySyncedMcpServers, type McpScope } from './sync-state.js';
import {
  collectMcpServers,
  type McpMergeResult,
  syncVscodeMcpConfig,
} from './vscode-mcp.js';

const USER_MCP_CLIENTS: Partial<Record<ClientType, true>> = {
  claude: true,
  codex: true,
  vscode: true,
  copilot: true,
  universal: true,
};

export interface SyncUserMcpAdaptersOptions {
  validPlugins: ValidatedPlugin[];
  config: WorkspaceConfig;
  previousState: SyncState | null;
  syncClients: ClientType[];
  dryRun?: boolean;
  force?: boolean;
}

export interface SyncUserMcpAdaptersResult {
  mcpResults: Partial<Record<McpScope, McpMergeResult>>;
  warnings: string[];
  trackedServers: Partial<Record<McpScope, string[]>>;
  complete: boolean;
}

/**
 * Reconcile ordinary user-scoped MCP destinations using the same ownership
 * semantics as a full user workspace sync.
 */
export async function syncUserMcpAdapters({
  validPlugins,
  config,
  previousState,
  syncClients,
  dryRun = false,
  force = false,
}: SyncUserMcpAdaptersOptions): Promise<SyncUserMcpAdaptersResult> {
  const warnings: string[] = [];
  const mcpResults: Partial<Record<McpScope, McpMergeResult>> = {};
  const trackedServers: Partial<Record<McpScope, string[]>> = {};
  let collectWarningsEmitted = false;

  function getServersForClient(client: ClientType): Map<string, unknown> {
    const { servers, warnings: collectWarnings } = collectMcpServers(
      validPlugins,
      config.mcpServers,
      client,
    );
    if (!collectWarningsEmitted) {
      warnings.push(...collectWarnings);
      collectWarningsEmitted = true;
    }
    return config.mcpProxy
      ? applyMcpProxy(servers, client, config.mcpProxy)
      : servers;
  }

  if (syncClients.includes('vscode')) {
    const result = syncVscodeMcpConfig(validPlugins, {
      dryRun,
      force,
      trackedServers: getPreviouslySyncedMcpServers(previousState, 'vscode'),
      serverOverrides: getServersForClient('vscode'),
    });
    warnings.push(...result.warnings);
    mcpResults.vscode = result;
    trackedServers.vscode = result.trackedServers;
  }

  if (syncClients.includes('codex')) {
    const result = await syncCodexMcpServers(validPlugins, {
      dryRun,
      trackedServers: getPreviouslySyncedMcpServers(previousState, 'codex'),
      serverOverrides: getServersForClient('codex'),
    });
    warnings.push(...result.warnings);
    mcpResults.codex = result;
    trackedServers.codex = result.trackedServers;
  }

  if (syncClients.includes('claude')) {
    const result = await syncClaudeMcpServersViaCli(validPlugins, {
      dryRun,
      trackedServers: getPreviouslySyncedMcpServers(previousState, 'claude'),
      serverOverrides: getServersForClient('claude'),
    });
    warnings.push(...result.warnings);
    mcpResults.claude = result;
    trackedServers.claude = result.trackedServers;
  }

  if (syncClients.includes('copilot')) {
    const result = syncClaudeMcpConfig(validPlugins, {
      dryRun,
      force,
      configPath: getCopilotMcpConfigPath(),
      trackedServers: getPreviouslySyncedMcpServers(previousState, 'copilot'),
      serverOverrides: getServersForClient('copilot'),
    });
    warnings.push(...result.warnings);
    mcpResults.copilot = result;
    trackedServers.copilot = result.trackedServers;
  }

  const allServers = collectMcpServers(validPlugins, config.mcpServers).servers;
  if (allServers.size > 0) {
    for (const client of syncClients) {
      if (!USER_MCP_CLIENTS[client]) {
        warnings.push(
          `MCP servers not synced for ${client} (not supported at user scope)`,
        );
      }
    }
  }

  return {
    mcpResults,
    warnings,
    trackedServers,
    complete: Object.values(mcpResults).every(
      (result) => result?.authoritative !== false,
    ),
  };
}
