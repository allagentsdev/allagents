import type { PluginStatus } from '../../core/status.js';
import { getPluginDisplayName, parseRemotePluginSource } from '../../utils/plugin-path.js';
import { terminalSafe } from '../terminal-output.js';

export function getPluginPresentation(plugin: PluginStatus, peers: PluginStatus[]) {
  const name = getPluginDisplayName(plugin.source);
  const collision = peers.some(
    (peer) => peer.source !== plugin.source && getPluginDisplayName(peer.source) === name,
  );
  const remote = parseRemotePluginSource(plugin.source);
  let source = plugin.source;
  if (remote?.type === 'github') {
    source = `${remote.owner}/${remote.repo}`;
    if (remote.branch && (collision || !['main', 'master'].includes(remote.branch))) {
      source += `@${remote.branch}`;
    }
    if (collision && remote.subpath) source += `/${remote.subpath}`;
  }
  return { name: terminalSafe(name), source: terminalSafe(source) };
}
