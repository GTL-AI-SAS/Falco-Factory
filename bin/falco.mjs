#!/usr/bin/env node
import path from 'node:path';
import { parseArgs, normalizeConfig, VERSION } from '../lib/args.mjs';
import { generate } from '../lib/generate.mjs';
import { deploy } from '../lib/deploy.mjs';
import { smoke } from '../lib/smoke.mjs';

function usage() {
  console.log(`FALCO FACTORY v${VERSION}\n\n` +
`Generate: npm run falco:new -- --name falco-gallinas --business "Gallinas y Valientes" --provider mock --origin http://localhost:3000 --faq ./examples/gallinas/faq.md --deploy\n\n` +
`Options: --name --business --provider mock|openai|gemini --model --origin --origins --faq --instructions --output --deploy --dry-run --force --account-id --rate-limit --rate-namespace --mock-reply\n` +
`Smoke:    npm run falco:smoke -- --url https://my-worker.example.workers.dev --chat [--business "Name"]\n\n` +
`--dry-run previews and does not write files. --force permits replacement of the same generated project and remote Worker.\n`);
}
function printReport(c, result, smokeResult) {
  console.log('\n=== FALCO FACTORY ===');
  console.log(`Business: ${c.business}\nWorker: ${c.name}\nProvider: ${c.provider} (${c.model})`);
  console.log(`Project generated: ${c.output}`);
  console.log(`Deployment: ${result.status}`);
  console.log(`Secrets: ${result.secret}`);
  if (result.url) {
    console.log(`Worker URL: ${result.url}\nChat URL: ${result.url}/chat`);
  }
  if (smokeResult) console.log(`Health check: OK${smokeResult.chat ? '\nChat check: OK' : ''}`);
  if (result.urlError) console.error(`URL: ${result.urlError}`);
  if (result.secretError) console.error(`NEXT ACTION: ${result.secretError}`);
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') return usage();
  if (command === 'smoke') {
    const flags = {};
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === '--chat') flags.chat = true;
      else if (['--url','--business','--origin'].includes(flag)) flags[flag.slice(2)] = rest[++i];
      else throw new Error(`Invalid smoke option ${flag}`);
    }
    if (!flags.url) throw new Error('smoke requires --url');
    const result = await smoke(flags.url, flags);
    console.log('Health: OK', JSON.stringify(result.health));
    if (result.chat) console.log('Chat: OK', JSON.stringify(result.chat));
    return;
  }
  if (command !== 'new') throw new Error(`Unknown command '${command}'`);
  const opts = parseArgs(rest);
  if (opts.help) return usage();
  const c = normalizeConfig(opts);
  console.log(`FALCO FACTORY v${VERSION}\nWorker: ${c.name}\nBusiness: ${c.business}\nProvider: ${c.provider}\nOrigin: ${c.origin}`);
  const generated = await generate(c);
  if (c.dryRun) {
    console.log(`DRY RUN — no file writes or cloud changes\nOutput: ${c.output}\nRemote deploy requested: no\nFiles: ${generated.files.join(', ')}`);
    return;
  }
  console.log(`Project generated: ${c.output}`);
  if (!c.deploy) {
    console.log('No remote changes made. Add --deploy when ready.');
    return;
  }
  let result;
  try { result = await deploy(c); }
  catch (e) {
    console.error(`Deployment NOT completed: ${e.message}`);
    console.error(`Generated files remain at ${c.output}`);
    process.exitCode = 1;
    return;
  }
  let checked = null;
  if (result.url && result.status === 'deployed') {
    try { checked = await smoke(result.url, { business: c.business, chat: c.provider === 'mock' }); }
    catch (e) { console.error(`Verification FAILED: ${e.message}`); process.exitCode = 1; }
  } else process.exitCode = 1;
  printReport(c, result, checked);
  if (result.status !== 'deployed' || !checked) process.exitCode = 1;
}
main().catch(e => { console.error(`Falco Factory: ${e.message}`); process.exitCode = 1; });
