import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function studioWorkspaceId(root = ROOT) {
  let resolved = path.resolve(root);
  try { resolved = realpathSync(resolved); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return createHash('sha256').update(resolved).digest('hex');
}

/** Reopen this workspace, or wait for its previous server to finish stopping. */
export async function startOrReopenStudio({ root, port, createApp, timeoutMs = 6000, retryMs = 100 }) {
  const app = createApp(), url = `http://127.0.0.1:${port}`;
  const workspaceId = studioWorkspaceId(root), deadline = Date.now() + timeoutMs;
  let occupied;
  for (;;) {
    try { return { app, url:await app.listen(), reused:false }; }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; occupied = error; }
    let boot;
    try {
      const response = await fetch(url + '/api/bootstrap', { signal:AbortSignal.timeout(750), redirect:'error' });
      if (response.ok) boot = await response.json();
    } catch { /* The old listener can disappear while it is shutting down. */ }
    if (boot?.studio === 'falco-factory' && boot.workspaceId !== workspaceId) {
      throw new Error(`Port ${port} belongs to another Falco Factory folder. Close that Studio or use --port to choose another port.`);
    }
    if (boot?.studio === 'falco-factory' && boot.workspaceId === workspaceId && /^[a-f0-9]{64}$/.test(boot.token)) {
      try {
        const response = await fetch(url + '/api/studio/reopen', { method:'POST', redirect:'error',
          headers:{'X-Falco-Local-Token':boot.token}, signal:AbortSignal.timeout(750) });
        await response.body?.cancel();
        if (response.ok) return {app:null,url,reused:true};
      } catch { /* Retry binding if shutdown won the race with reopening. */ }
    }
    if (Date.now() >= deadline) {
      occupied.message = `Port ${port} is still occupied and could not be reopened as this Studio. Close the other application or choose another --port.`;
      throw occupied;
    }
    await pause(retryMs);
  }
}
