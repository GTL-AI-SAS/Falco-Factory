#!/usr/bin/env node
import path from 'node:path';
import { VERSION } from '../lib/args.mjs';
import { createUiServer } from '../lib/ui-server.mjs';
import { startOrReopenStudio } from '../lib/studio-launch.mjs';
import { openStudioBrowser } from '../lib/studio-browser.mjs';

function options(args) {
  const result = { port: 4317, open: true, exitOnClose: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      result.port = Number(args[++i]);
      if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error('--port must be between 1024 and 65535');
    } else if (args[i] === '--root') {
      const root = args[++i];
      if (!root || root.startsWith('--')) throw new Error('--root requires a workspace directory.');
      result.root = path.resolve(root);
    } else if (args[i] === '--no-open') result.open = false;
    else if (args[i] === '--exit-on-close') result.exitOnClose = true;
    else if (args[i] === '--help') { console.log('Usage: npm run falco:ui -- [--port 4317] [--root directory] [--no-open] [--exit-on-close]'); process.exit(0); }
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return result;
}
try {
  const opts = options(process.argv.slice(2));
  const autoClose = opts.open || opts.exitOnClose;
  const { app, url, reused } = await startOrReopenStudio({root:opts.root, port:opts.port,
    createApp:() => createUiServer({ root:opts.root, port:opts.port, exitOnBrowserClose:autoClose })});
  console.log(`\nFALCO FACTORY STUDIO v${VERSION}\n\nLocal UI: ${url}\nCloudflare deployments still use Wrangler.\nCloudflare stores provider credentials as Worker secrets.\nThis server listens on 127.0.0.1 only. ${autoClose ? 'Closing the last Studio tab stops the server after ongoing operations finish.' : 'Press Ctrl+C to stop.'}\n`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void app.close().catch(error => {
      console.error('Falco Studio shutdown: ' + error.message);
      process.exitCode = 1;
    });
  };
  if (!reused) {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  if (opts.open) await openStudioBrowser(url);
  if (reused) console.log('Reopened the existing Studio session.');
} catch (err) {
  console.error(`Falco Studio: ${err.message}`);
  process.exitCode = 1;
}
