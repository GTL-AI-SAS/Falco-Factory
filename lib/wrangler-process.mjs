import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
export function rawWrangler(args, { cwd = ROOT, stdio = 'capture', input, accountId,
  env = process.env, signal, timeoutMs = Number(process.env.FALCO_WRANGLER_TIMEOUT_MS ?? 120000) } = {}) {
  if (!fs.existsSync(WRANGLER)) throw new Error('Wrangler not installed. Run npm install in the Falco Factory directory.');
  return runProcess(process.execPath, [WRANGLER, ...args], { cwd, interactive: stdio === 'inherit', input, signal, timeoutMs,
    env: { ...env, ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}), WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG: 'log' } });
}

export function runProcess(command, args, { cwd, env, interactive = false, input, signal, timeoutMs = 120000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Wrangler timeout must be 1–600000 ms.');
  const recovery = reason => new Error(reason + ' Check the Worker’s remote state before retrying the operation.');
  if (signal?.aborted) return Promise.reject(recovery('Wrangler cancelled.'));
  return new Promise((resolve, reject) => {
    const separateGroup = process.platform !== 'win32' && !interactive;
    const child = spawn(command, args, { cwd, env, shell: false, detached: separateGroup, windowsHide: !interactive,
      stdio: interactive ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, stopped, forceTimer;
    const kill = force => {
      if (!child.pid) return;
      try {
        if (separateGroup) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else if (process.platform === 'win32') {
          const flags = ['/PID', String(child.pid), '/T'];
          if (force) flags.push('/F');
          const killer = spawn('taskkill.exe', flags, { windowsHide: true, stdio: 'ignore', shell: false });
          killer.on('error', () => child.kill());
          // Restricted Windows environments may start taskkill but deny its request.
          // In that case terminate our own child directly rather than leaving it alive.
          killer.on('close', code => { if (code !== 0) child.kill(); });
        } else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch (error) { if (error.code !== 'ESRCH') child.kill(); }
    };
    const stop = message => {
      if (stopped) return;
      stopped = recovery(message);
      kill(false);
      forceTimer = setTimeout(() => {
        kill(true);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 1500);
    };
    const abort = () => stop('Wrangler cancelled.');
    const timer = setTimeout(() => stop('Wrangler exceeded its time limit.'), timeoutMs);
    const finish = (code, error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      if (stopped || error) reject(stopped ?? error);
      else if (interactive && code !== 0) reject(new Error('Wrangler exited with code ' + code));
      else resolve({ code, stdout, stderr });
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      stream?.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 250000) return stop('Wrangler output exceeded its safe limit.');
        if (isError) stderr += chunk;
        else stdout += chunk;
      });
    }
    child.on('error', error => finish(null, error));
    child.on('close', code => {
      if (!stopped) finish(code);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(`${input}\n`);
    }
  });
}
