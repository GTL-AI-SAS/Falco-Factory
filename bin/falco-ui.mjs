#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createUiServer } from '../lib/ui-server.mjs';

function options(args) {
  const result = { port: 4317, open: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      result.port = Number(args[++i]);
      if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error('--port must be between 1024 and 65535');
    } else if (args[i] === '--no-open') result.open = false;
    else if (args[i] === '--help') { console.log('Usage: npm run falco:ui -- [--port 4317] [--no-open]'); process.exit(0); }
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return result;
}
function openBrowser(url) {
  let child;
  if (process.platform === 'win32') child = spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
  else if (process.platform === 'darwin') child = spawn('open', [url], { stdio: 'ignore' });
  else child = spawn('xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
try {
  const opts = options(process.argv.slice(2));
  const app = createUiServer({ port: opts.port });
  const url = await app.listen();
  console.log(`\nFALCO FACTORY STUDIO v0.8\n\nLocal UI: ${url}\nCloudflare deployments still use Wrangler.\nSecrets remain in memory and are passed to Wrangler via stdin.\nThis server listens on 127.0.0.1 only. Press Ctrl+C to stop.\n`);
  if (opts.open) openBrowser(url);
} catch (err) {
  console.error(`Falco Studio: ${err.message}`);
  process.exitCode = 1;
}
