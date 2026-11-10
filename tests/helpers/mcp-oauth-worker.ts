import { rename, rm } from 'node:fs/promises';
import { buildOAuthProvider, getMcpOAuthCacheDir, runWithMcpOAuthReset } from '../../src/core/mcp-oauth-provider.js';

const [mode, serverUrl] = process.argv.slice(2);
if (!serverUrl) throw new Error('Missing OAuth fixture server URL');
if (mode?.startsWith('reset')) {
  const cacheDir = getMcpOAuthCacheDir(serverUrl);
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort(new Error('reset cancelled')));
  console.log('reset-queued');
  await runWithMcpOAuthReset(cacheDir, async () => {
    await fetch(new URL('/reset-start', serverUrl));
    const backup = `${cacheDir}.worker-backup`;
    let backedUp = false;
    try {
      await rename(cacheDir, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const fresh = await buildOAuthProvider(serverUrl);
    try {
      await fresh.runWithAuthorizationLock(() => fresh.saveTokens({ access_token: 'reset-token', token_type: 'Bearer', expires_in: 3600 }));
      console.log(JSON.stringify(fresh.tokens()));
    } catch (error) {
      await rm(cacheDir, { recursive: true, force: true });
      if (backedUp) await rename(backup, cacheDir);
      throw error;
    } finally {
      fresh.dispose();
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
  }, { signal: controller.signal });
} else {
  const provider = await buildOAuthProvider(serverUrl);
  try {
    if (mode === 'refresh') {
      const response = await provider.wrapFetch(fetch)(new URL('/token', serverUrl), {
        method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'old-refresh' }),
      });
      if (!response.ok) throw new Error('Refresh failed');
      console.log(JSON.stringify(await response.json()));
    } else {
      await provider.runWithAuthorizationLock(async () => {
        if (mode === 'hold') {
          console.log('locked');
          await new Promise(() => setInterval(() => {}, 1000));
        }
        if (!provider.tokens()) {
          const response = await provider.wrapFetch(fetch)(new URL('/token', serverUrl), {
            method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'fresh' }),
          });
          if (!response.ok) throw new Error('Authorization failed');
        }
        console.log(JSON.stringify(provider.tokens()));
      });
    }
  } finally {
    provider.dispose();
  }
}
